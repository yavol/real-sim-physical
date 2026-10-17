"""Runs only inside Modal. Real GR00T actions drive the MuJoCo GR-1."""
import io
import json
import os
from pathlib import Path
import queue
import shutil
import threading
import time
import traceback

MODEL_ID = "nvidia/GR00T-N1.6-3B"
MODEL_REVISION = "d0814e7ecb19202e7c8468b46098b0b7ef3a6d61"
ASSETS_VERSION = "1b018839a6da865dffecd3185fe054211bc71270"
ASSET_SOURCE = Path("/opt/robocasa/robocasa/models/assets")
ASSET_CACHE = Path("/cache/robocasa-assets")
MODEL_PATH = Path("/cache/model")
STOCK_ENV = "gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env"


def link_assets():
    if ASSET_SOURCE.is_symlink():
        return
    if not ASSET_CACHE.exists():
        shutil.copytree(ASSET_SOURCE, ASSET_CACHE)
    else:
        shutil.copytree(ASSET_SOURCE, ASSET_CACHE, dirs_exist_ok=True)
    shutil.rmtree(ASSET_SOURCE)
    ASSET_SOURCE.symlink_to(ASSET_CACHE, target_is_directory=True)


def prepare(commit=lambda: None):
    """CPU-only preparation: cache downloads without renting a GPU."""
    from huggingface_hub import snapshot_download
    import sys
    link_assets()
    sys.path.insert(0, "/opt/robocasa/robocasa/scripts")
    from download_kitchen_assets import DOWNLOAD_ASSET_REGISTRY, download_and_extract_zip
    registries = dict(DOWNLOAD_ASSET_REGISTRY)
    for registry in ("sketchfab", "lightwheel"):
        registries[registry] = dict(
            message=f"Downloading {registry}",
            url=f"https://huggingface.co/datasets/nvidia/PhysicalAI-DigitalCousin-Assets/resolve/{ASSETS_VERSION}/{registry}.zip",
            folder=str(ASSET_SOURCE / "objects" / registry), check_folder_exists=False,
        )
    for name, config in registries.items():
        if name in ("aigen_objs", "generative_textures"):
            continue
        marker = ASSET_CACHE / f".downloaded-{name}"
        if not marker.exists():
            print(f"PREPARING ASSETS: {name}", flush=True)
            download_and_extract_zip(**config)
            if not Path(config["folder"]).exists():
                raise RuntimeError(f"Download did not create {config['folder']}")
            marker.write_text(ASSETS_VERSION)
            commit()
    revision_file = Path("/cache/model-revision.txt")
    revision = MODEL_REVISION
    print(f"PREPARING MODEL: {MODEL_ID}@{revision}", flush=True)
    snapshot_download(MODEL_ID, revision=revision, local_dir=MODEL_PATH,
                      allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.py", "*.jinja"])
    revision_file.write_text(revision)
    Path("/cache/prepared.json").write_text(json.dumps({"model": MODEL_ID, "revision": revision, "assets": ASSETS_VERSION}))
    commit()
    return json.loads(Path("/cache/prepared.json").read_text())


class Engine:
    def __init__(self):
        import torch
        from gr00t.data.embodiment_tags import EmbodimentTag
        from gr00t.policy.gr00t_policy import Gr00tPolicy, Gr00tSimPolicyWrapper
        if not Path("/cache/prepared.json").exists():
            raise RuntimeError("Run prepare_assets first to cache model and simulator assets on CPU.")
        link_assets()
        torch.set_num_threads(4)
        started = time.monotonic()
        self.policy = Gr00tSimPolicyWrapper(Gr00tPolicy(EmbodimentTag.GR1, str(MODEL_PATH), device="cuda"))
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.loaded_seconds = round(time.monotonic() - started, 2)
        self.jobs = queue.Queue()
        self.view_condition = threading.Condition()
        self.camera_settings = {"azimuth": -90., "elevation": -17., "distance": 1.8}
        self.camera_version = 0
        self.rendered_version = -1
        self.last_frame = None
        self.current_env = None
        self.current_renderer = None
        self.frame_callback = None
        self.actor = threading.Thread(target=self._actor_loop, daemon=True)
        self.actor.start()

    def _actor_loop(self):
        """Own every MuJoCo/EGL context on one persistent thread."""
        while True:
            try:
                request, out = self.jobs.get(timeout=.1)
            except queue.Empty:
                with self.view_condition:
                    needs_render = self.camera_version > self.rendered_version
                if needs_render and self.frame_callback is not None:
                    try:
                        self.frame_callback()
                    except Exception:
                        traceback.print_exc()
                continue
            try:
                for event in self._execute(request):
                    out.put(event)
            except Exception as exc:
                traceback.print_exc()
                out.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
            finally:
                out.put(None)

    def set_camera(self, settings):
        if self.frame_callback is None:
            return {"needs_scene": True, "message": "Run a task to initialize the 3D scene."}
        with self.view_condition:
            for key, bounds in {"azimuth": (-1080, 1080), "elevation": (-80, 25), "distance": (.8, 4.)}.items():
                if key in settings:
                    self.camera_settings[key] = max(bounds[0], min(bounds[1], float(settings[key])))
            self.camera_version += 1
            requested_version = self.camera_version
            self.view_condition.wait_for(lambda: self.rendered_version >= requested_version, timeout=3)
            return {**(self.last_frame or {}), "camera": dict(self.camera_settings), "camera_only": True}

    def health(self):
        import torch
        configs = self.policy.get_modality_config()
        return {"ready": True, "model": MODEL_ID, "robot": "Fourier GR-1 / arms, waist, Fourier hands",
                "gpu": torch.cuda.get_device_name(), "load_seconds": self.loaded_seconds,
                "memory_gb": round(torch.cuda.memory_allocated() / 2**30, 2),
                "modalities": {k: {"keys": v.modality_keys, "delta_indices": v.delta_indices} for k, v in configs.items()},
                "revision": json.loads(Path("/cache/prepared.json").read_text())["revision"]}

    def _make_env(self, scene, seed):
        import gymnasium as gym
        import robocasa
        from robocasa.utils.gym_utils import GrootRoboCasaEnv
        if scene == "stock":
            return gym.make(STOCK_ENV, enable_render=True, seed=seed)
        from robocasa.environments.tabletop.tabletop_multi_pnp import PutAllObjectsInContainer
        # Registration uses the same official robot/controller/camera adapter.
        class DrinksToBox(PutAllObjectsInContainer):
            NUM_OBJECTS = 2
            def __init__(self, *args, **kwargs):
                super().__init__(*args, obj_groups=["can", "bottled_water"],
                                 container_type="cardboard_box", handedness="right", **kwargs)
        return GrootRoboCasaEnv(env_name="DrinksToBox", robots_name="GR1ArmsAndWaistFourierHands",
                               enable_render=True, seed=seed, layout_ids=[0], style_ids=[0])

    @staticmethod
    def _objects(env):
        from robocasa.utils import object_utils as OU
        raw = env.unwrapped.env
        result = {}
        for name in raw.objects:
            try:
                obj = raw.objects[name]
                body = raw.sim.model.body_name2id(obj.root_body)
                item = {"position": raw.sim.data.body_xpos[body].round(4).tolist(),
                        "label": raw.get_obj_lang(obj_name=name)}
                if name.startswith("obj_") and "container" in raw.objects:
                    item["in_box"] = bool(OU.check_obj_in_receptacle(raw, name, "container"))
                result[name] = item
            except Exception:
                continue
        return result

    def rollout(self, request):
        if not self.lock.acquire(blocking=False):
            yield {"type": "error", "message": "A rollout is already running. Stop it before starting another."}
            return
        out = queue.Queue(maxsize=24)
        finished = False
        self.stop_event.clear()
        self.jobs.put((request, out))
        try:
            while True:
                event = out.get()
                if event is None:
                    finished = True
                    break
                yield event
        finally:
            if not finished:
                self.stop_event.set()
                # Drain output so a disconnected stream cannot block the actor.
                while True:
                    try:
                        if out.get(timeout=5) is None:
                            break
                    except queue.Empty:
                        break
            self.lock.release()

    def _execute(self, request):
        import numpy as np
        import torch
        from PIL import Image
        import imageio.v2 as imageio
        env = None
        writer = None
        spectator = None
        started = time.monotonic()
        scene = request.get("scene", "drinks")
        max_steps = max(8, min(1000, int(request.get("max_steps", 400))))
        seed = int(request.get("seed", 42))
        run_id = request.get("run_id", f"run-{int(time.time())}")
        recording = Path("/tmp") / f"{run_id}.mp4"
        try:
            self.frame_callback = None
            if self.current_renderer is not None:
                self.current_renderer.close()
                self.current_renderer = None
            if self.current_env is not None:
                self.current_env.close()
                self.current_env = None
            yield {"type": "status", "message": "Creating scene", "scene": scene}
            torch.manual_seed(seed)
            env = self._make_env(scene, seed)
            obs, info = env.reset(seed=seed)
            import mujoco
            raw = env.unwrapped.env
            if scene == "drinks" and request.get("swap_objects", False):
                addresses = []
                for name in ("obj_0", "obj_1"):
                    joint = raw.sim.model.joint_name2id(raw.objects[name].joints[0])
                    addresses.append(int(raw.sim.model._model.jnt_qposadr[joint]))
                a, b = addresses
                first_xy = raw.sim.data.qpos[a:a+2].copy()
                raw.sim.data.qpos[a:a+2] = raw.sim.data.qpos[b:b+2].copy()
                raw.sim.data.qpos[b:b+2] = first_xy
                raw.sim.forward()
                basic_obs = env.unwrapped.get_basic_observation(raw._get_observations(force_update=True))
                obs = env.unwrapped.get_groot_observation(basic_obs)
            spectator = mujoco.Renderer(raw.sim.model._model, height=480, width=720)
            self.current_env, self.current_renderer = env, spectator
            camera = mujoco.MjvCamera()
            center = np.mean([v["position"] for v in self._objects(env).values()], axis=0)
            camera.lookat[:] = [2.65, -1.93, 1.12]
            scene_option = mujoco.MjvOption()
            # robosuite: group 0 = collision hulls, group 1 = visual meshes.
            scene_option.geomgroup[0] = 0
            scene_option.geomgroup[1] = 1
            default_command = obs.get("annotation.human.coarse_action", "")
            command = request.get("command", "").strip() or default_command
            if not command.startswith(("unlocked_waist:", "locked_waist:")):
                command = "unlocked_waist: " + command
            yield {"type": "ready", "command": command, "default_command": default_command,
                   "objects": self._objects(env), "health": self.health(), "max_steps": max_steps,
                   "swap_objects": bool(request.get("swap_objects", False))}
            writer = imageio.get_writer(recording, fps=20, codec="libx264", quality=7, macro_block_size=2)
            steps = 0
            inference_times = []
            success = False
            configs = self.policy.get_modality_config()

            def render_frame():
                # The policy still sees only its official egocentric observation.
                with self.view_condition:
                    settings = dict(self.camera_settings)
                camera.azimuth = settings["azimuth"]
                camera.elevation = settings["elevation"]
                camera.distance = settings["distance"]
                spectator.update_scene(raw.sim.data._data, camera=camera, scene_option=scene_option)
                outside = spectator.render().copy()
                ego = Image.fromarray(env.render())
                ego.thumbnail((240, 150))
                composite = Image.fromarray(outside)
                composite.paste(ego, (720 - ego.width - 12, 12))
                return np.asarray(composite)

            def frame_event():
                with self.view_condition:
                    version = self.camera_version
                frame = render_frame()
                preview = Image.fromarray(frame)
                preview.thumbnail((960, 600))
                buff = io.BytesIO()
                preview.save(buff, format="JPEG", quality=82)
                event = {"type": "frame", "jpeg": buff.getvalue(), "step": steps,
                        "max_steps": max_steps,
                        "sim_seconds": round(steps / 20, 2), "wall_seconds": round(time.monotonic() - started, 2),
                        "success": success, "objects": self._objects(env),
                        "inference_ms": round(inference_times[-1] * 1000) if inference_times else None,
                        "camera": dict(self.camera_settings)}
                with self.view_condition:
                    self.last_frame = event
                    self.rendered_version = version
                    self.view_condition.notify_all()
                return event

            self.frame_callback = frame_event
            yield frame_event()
            self.policy.reset()
            while steps < max_steps and not self.stop_event.is_set():
                batched = {}
                for modality in ("video", "state"):
                    for key in configs[modality].modality_keys:
                        flat = f"{modality}.{key}"
                        batched[flat] = np.repeat(obs[flat][None, None], len(configs[modality].delta_indices), axis=1)
                batched["annotation.human.coarse_action"] = [command]
                tick = time.monotonic()
                actions, _ = self.policy.get_action(batched)
                torch.cuda.synchronize()
                inference_times.append(time.monotonic() - tick)
                if not all(np.isfinite(a).all() for a in actions.values()):
                    raise RuntimeError("Model produced a non-finite action; rollout stopped.")
                for i in range(min(8, next(iter(actions.values())).shape[1], max_steps - steps)):
                    if self.stop_event.is_set():
                        break
                    action = {k: v[0, i].copy() for k, v in actions.items()}
                    obs, reward, done, truncated, info = env.step(action)
                    steps += 1
                    writer.append_data(render_frame())
                    success = bool(info.get("success", False)) or success
                    if steps % 4 == 0 or success:
                        yield frame_event()
                    if success:
                        break
                if success:
                    break
            writer.close()
            writer = None
            yield {"type": "recording", "mp4": recording.read_bytes()}
            yield {"type": "result", "success": success, "steps": steps,
                   "stopped": self.stop_event.is_set(), "command": command,
                   "objects": self._objects(env), "wall_seconds": round(time.monotonic() - started, 2),
                   "mean_inference_ms": round(1000 * np.mean(inference_times)) if inference_times else None}
        except Exception as exc:
            traceback.print_exc()
            yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
        finally:
            if writer is not None:
                writer.close()
            recording.unlink(missing_ok=True)
            if env is not None and env is not self.current_env:
                env.close()
