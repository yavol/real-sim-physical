# Tabletop / GR-1 command lab

A local console for sending natural-language instructions to **NVIDIA GR00T N1.6 3B**, controlling a simulated **Fourier GR-1 with Fourier hands and an unlocked waist** on Modal. This uses the real learned NVIDIA policy and the official GR-1 observation/action adapter. It does not use a scripted grasp controller.

## Open the console

```sh
./start-demo.sh
```

Open <http://127.0.0.1:8765>. The server binds only to this laptop. The Modal SDK uses the existing active local profile; no credentials are sent to the browser.

Choose a scene and seed, enter a command, and press **Run instruction**. **Stop** requests cancellation after the current inference step. Every run starts from a fresh scene. Reuse a seed to compare instructions; the simulator and model random seeds are reset together. Recordings and JSON results are saved under `artifacts/runs/`.

Click and drag the simulation image to orbit. Use the **+ / −** buttons to zoom, or **Front**, **Back**, and **Top** for preset views. Scrolling does not change the camera, and dragging keeps the camera distance fixed. The viewpoint can be changed during a rollout and afterward. The small inset shows the robot's actual policy camera. Camera changes during a run are included in its recording; they do not change what the NVIDIA model sees.

The GPU keeps the last scene available for inspection during its 10-minute idle window. After the container sleeps, start a new run to initialize another interactive scene.

- **Can + bottle + box** is a custom two-object scene using stock RoboCasa assets. Try “Put the can into the cardboard box” or “Put the water bottle into the cardboard box.” Object-level box checks are geometric simulation checks. The full scene success flag requires both objects in the box and the hands withdrawn; inspect the individual checks when giving a one-object instruction.
- **Stock: bottle → cabinet** runs the official `PnPBottleToCabinetClose` environment. Leave the command blank for its original instruction.

**Swap can / bottle positions** exchanges their planar starting positions while preserving each object's proper resting height. It is useful for testing whether object selection follows language or location.

Simple one-object box instructions receive an object-specific final check, such as **BOTTLE IN BOX** or **CAN OUTSIDE BOX**. Arbitrary instructions retain the physical object checks without an automatic language verdict. A live `in_box` flag can be true while an object is still held above the rim; assess the final recording and settled position.

## Verified example and limitations

Use **Can + bottle + box**, seed **44**, **400** steps, swap **off**, and:

> Put the water bottle into the cardboard box.

The recording `artifacts/runs/20261017-141442-81fe2a/rollout.mp4` shows the real policy grasping the bottle, lifting it, releasing it into the box, and leaving it settled there from about 11 to 20 seconds. An independent visual audit agreed with the final geometric check. A repeat, `artifacts/runs/20261017-141705-89f1b9/rollout.mp4`, achieved the same final placement from a different viewing angle. The scene benchmark flag is still false because the can remains outside; the requested bottle goal is achieved.

The checkpoint is unmodified. Scene seed and camera settings were tuned; no policy training or scripted grasping was added. Other trials failed: seed 43 dropped the bottle outside, seed 42 can commands moved the bottle, and swapping positions caused the can to topple. These recordings remain in the run log. This is an exploratory demo with one working configuration reproduced twice, rather than evidence of reliable arbitrary instruction following.

The model receives the command plus its official `unlocked_waist:` embodiment prefix. It receives camera observations and robot joint states, then predicts action chunks. Eight actions are executed before it observes the world again. Display and recording time follows the simulator at 20 Hz; wall-clock execution may be slower.

## Rebuild or redeploy

```sh
uv venv --cache-dir /private/tmp/vast-hack-uv-cache .venv
uv pip install --cache-dir /private/tmp/vast-hack-uv-cache --python .venv/bin/python -r requirements-local.txt
.venv/bin/modal run modal_app.py --prepare
.venv/bin/modal deploy modal_app.py
.venv/bin/modal run modal_app.py --probe
```

Preparation downloads public weights and simulator assets on CPU and persists them in the `vast-gr1-cache` Modal Volume. Inference uses one L40S, capped at one container, and scales to zero after 10 idle minutes. A new run reloads the model if it has gone to sleep. The deployed runtime has no public web endpoint.

To stop the deployed app entirely:

```sh
.venv/bin/modal app list
.venv/bin/modal app stop APP_ID
```

## Pinned upstream code

- [Isaac-GR00T N1.6](https://github.com/NVIDIA/Isaac-GR00T/tree/9b37aa1ce69c73c6d165233fa88128283bba4508): `9b37aa1ce69c73c6d165233fa88128283bba4508`
- [RoboCasa GR-1 tabletop tasks](https://github.com/robocasa/robocasa-gr1-tabletop-tasks/tree/4840e671596f93ca03651524b9f72ffb1aadfeff): `4840e671596f93ca03651524b9f72ffb1aadfeff`
- [Model](https://huggingface.co/nvidia/GR00T-N1.6-3B): the resolved immutable model revision is saved in the Modal cache and returned by the health check.
- robosuite 1.5.1; PyTorch 2.7.1 CUDA 12.8; FlashAttention 2.7.4.post1.

This checkpoint supports this GR-1 embodiment. A new scene and arbitrary language instructions remain generalization tests; simulator support alone does not guarantee a successful grasp or completed task. This setup does not train a policy from a webcam recording.

## Search and organize videos

Run `./start-library.sh` and open [Relay Video Library](http://127.0.0.1:8791). Upload videos, search titles/descriptions/tags, sort by date/name/duration/size, star favorites, and watch recordings. Human demonstrations and robot simulation recordings have separate filters. The Capture studio's **Save to library** saves a finished recording and its session evidence directly to the local library; reload Capture before a new session to get the new controls.

Videos and metadata persist locally under `artifacts/library/`. A server-side VAST VSS connector supports authenticated browsing and content search once workspace access is available; local uploads are not automatically ingested into VAST. See [the library guide](library/README.md) for setup and the verified connection boundary.
