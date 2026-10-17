"""Private Modal runtime for the GR-1 tabletop command lab.

Deploy: .venv/bin/modal deploy modal_app.py
Prepare: .venv/bin/modal run modal_app.py --prepare
Probe: .venv/bin/modal run modal_app.py --probe
"""
from pathlib import Path

import modal

APP_NAME = "vast-gr1-tabletop"
GROOT_COMMIT = "9b37aa1ce69c73c6d165233fa88128283bba4508"
ROBOCASA_COMMIT = "4840e671596f93ca03651524b9f72ffb1aadfeff"
ROOT = Path(__file__).parent
app = modal.App(APP_NAME)
cache = modal.Volume.from_name("vast-gr1-cache", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04", add_python="3.10")
    .apt_install("git", "curl", "ffmpeg", "build-essential", "libegl1", "libgl1", "libglib2.0-0", "libglfw3", "libosmesa6", "libxkbcommon0")
    .env({
        "MUJOCO_GL": "egl", "PYOPENGL_PLATFORM": "egl",
        "NVIDIA_DRIVER_CAPABILITIES": "compute,utility,graphics",
        "HF_HOME": "/cache/huggingface", "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "4",
        "PYTHONPATH": "/opt/Isaac-GR00T:/opt/robocasa:/opt/demo",
        "SDL_VIDEODRIVER": "dummy", "PYNPUT_BACKEND": "dummy",
    })
    .pip_install("torch==2.7.1", "torchvision==0.22.1", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        "numpy==1.26.4", "mujoco==3.2.6", "numba==0.61.2",
        "transformers==4.51.3", "diffusers==0.35.1", "peft==0.17.1", "accelerate==1.10.1",
        "albumentations==1.4.18", "opencv-python-headless==4.11.0.86",
        "av==16.1.0", "dm-tree==0.1.8", "lmdb==1.7.5", "pandas==2.2.3",
        "msgpack==1.1.0", "msgpack-numpy==0.4.8", "termcolor==3.2.0", "tyro==0.9.17",
        "click==8.1.8", "datasets==3.6.0", "einops==0.8.1", "gitpython==3.1.46",
        "gymnasium==1.2.2", "matplotlib==3.10.1", "omegaconf==2.3.0", "scipy==1.15.3",
        "wandb==0.23.0", "pyzmq==27.0.1", "pillow", "imageio[ffmpeg]", "h5py", "lxml",
        "pygame", "pyyaml", "pynput", "hidapi", "tianshou==0.5.1", "pyopengl", "robosuite==1.5.1",
        "setuptools<81", "wheel", "ninja", "torchcodec==0.4.0",
        env={"CC": "gcc", "CXX": "g++"},
    )
    .run_commands(
        "python -c \"import torch,subprocess,sys; abi=str(torch._C._GLIBCXX_USE_CXX11_ABI).upper(); subprocess.check_call([sys.executable,'-m','pip','install','--no-deps',f'https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1%2Bcu12torch2.7cxx11abi{abi}-cp310-cp310-linux_x86_64.whl'])\"",
        f"git init /opt/Isaac-GR00T && cd /opt/Isaac-GR00T && git remote add origin https://github.com/NVIDIA/Isaac-GR00T.git && GIT_LFS_SKIP_SMUDGE=1 git fetch --depth 1 origin {GROOT_COMMIT} && git checkout FETCH_HEAD",
        f"git init /opt/robocasa && cd /opt/robocasa && git remote add origin https://github.com/robocasa/robocasa-gr1-tabletop-tasks.git && git fetch --depth 1 origin {ROBOCASA_COMMIT} && git checkout FETCH_HEAD",
        "mkdir -p /usr/share/glvnd/egl_vendor.d && printf '%s' '{\"file_format_version\":\"1.0.0\",\"ICD\":{\"library_path\":\"libEGL_nvidia.so.0\"}}' > /usr/share/glvnd/egl_vendor.d/10_nvidia.json",
        "python -c 'import gr00t.model; import robocasa; import flash_attn; print(\"Inference and simulation imports OK\")'",
    )
    .pip_install("fastapi==0.115.12")
    .add_local_file(ROOT / "robot_runtime.py", "/opt/demo/robot_runtime.py")
)


@app.function(image=image, volumes={"/cache": cache}, timeout=7200, cpu=4, memory=16384)
def prepare_assets():
    from robot_runtime import prepare
    return prepare(cache.commit)


@app.cls(image=image, gpu="L40S", volumes={"/cache": cache}, cpu=8, memory=32768,
         timeout=1800, startup_timeout=900, scaledown_window=600, max_containers=1)
@modal.concurrent(max_inputs=4)
class RobotLab:
    @modal.enter()
    def load(self):
        from robot_runtime import Engine
        self.engine = Engine()

    @modal.method()
    def health(self):
        return self.engine.health()

    @modal.method()
    def stop(self):
        self.engine.stop_event.set()
        return {"stopping": True}

    @modal.method()
    def set_camera(self, settings: dict):
        return self.engine.set_camera(settings)

    @modal.method(is_generator=True)
    def rollout(self, request: dict):
        yield from self.engine.rollout(request)


@app.local_entrypoint()
def main(prepare: bool = False, probe: bool = False, scene: str = "stock", command: str = "", steps: int = 80, seed: int = 42):
    import json
    if prepare:
        print(json.dumps(prepare_assets.remote(), indent=2))
    elif probe:
        print(json.dumps(RobotLab().health.remote(), indent=2))
    else:
        out = ROOT / "artifacts" / "runs" / "probe"
        out.mkdir(parents=True, exist_ok=True)
        for event in RobotLab().rollout.remote_gen({"scene": scene, "command": command, "max_steps": steps, "seed": seed}):
            if event.get("type") == "frame":
                (out / "latest.jpg").write_bytes(event.pop("jpeg"))
            elif event.get("type") == "recording":
                (out / "rollout.mp4").write_bytes(event.pop("mp4"))
            print(json.dumps(event, default=str))
