# Tabletop policy demo

The user authorized deploying a real GR00T tabletop demo on their Modal account. Use the existing active `yavol` Modal CLI profile; do not change or print credentials. Keep all third-party source checkouts under `.vendor/` and preserve existing files under `artifacts/uploads/`.

## Intended runtime

- Fourier GR-1 humanoid, supported by the GR00T N1.6 `GR1` embodiment.
- Pin the NVIDIA Isaac-GR00T `n1d6` code path and `nvidia/GR00T-N1.6-3B` weights. The current N1.7 base does not directly support this RoboCasa GR-1 simulation embodiment.
- First run a stock RoboCasa GR-1 task, then configure a can, water bottle, and cardboard box for exploratory commands.
- Run the actual learned NVIDIA policy and robotics simulation together on one Modal L40S; serve a local command console with live rollout frames, metrics, and recordings.
- Do not represent scene support as verified policy success. Keep model outputs, success checks, and recordings inspectable.

## Initial inspection

- Workspace initially has only `artifacts/uploads/` from the user's VAST upload test and is not a Git checkout.
- This laptop is an Apple M4 MacBook Air with 16 GB unified memory.
- `~/.modal.toml` exists with an active `yavol` profile and non-empty credentials. Modal SDK was not installed in the default Python.
- Installing local dependencies into `.venv/` with uv cache in `/private/tmp/vast-hack-uv-cache`.
- Downloading official NVIDIA source to `.vendor/Isaac-GR00T`.

## Implementation

- Pinned Isaac-GR00T to `9b37aa1ce69c73c6d165233fa88128283bba4508` and RoboCasa GR-1 to `4840e671596f93ca03651524b9f72ffb1aadfeff`.
- Built a private Modal class with one L40S maximum, 10-minute idle scale-down, real policy action chunks, streaming frames, cancellation, and recordings. No public GPU HTTP endpoint.
- Wrote a CPU asset/model preparation function and started the first image build. Runtime success is still pending verification.
- Created a FastAPI command console at `http://127.0.0.1:8765` and opened it in the existing Yaroslav Chrome profile.
- Custom scene subclasses the stock multi-object tabletop task with a can, water bottle, and cardboard box. Full scene success requires both objects; per-object geometry is reported separately.

## Live verification

- CPU preparation completed, caching assets and model revision `d0814e7ecb19202e7c8468b46098b0b7ef3a6d61`.
- Deployed private app: `vast-gr1-tabletop`, app ID `ap-tPOHqOj8x5WEK3bFRd63mH` in workspace `yavol`.
- Actual NVIDIA L40S inference verified, approximately 6.2 GB allocated and about 90 ms per action chunk in warm trials. Executes eight of sixteen predicted actions per observation.
- Fixed spectator rendering by disabling collision-geometry group 0, matching the simulator's visual-only camera. Added front/back/top, drag orbit, and zoom. A dedicated actor thread owns all render contexts so the completed scene can be inspected after the rollout RPC ends.
- Local request validation, external-origin rejection, idle stop, Python syntax, JavaScript syntax, and requested-object checks passed. A stopped 288-step run was saved.
- `20261017-141442-81fe2a`: seed 44, bottle instruction, 400 steps, original positions. Bottle goal achieved. Independent Astra inspection confirms grasp, release, and stable placement from approximately 11 to 20 seconds. Full two-object benchmark success remains false.
- Retained unsuccessful trials and visual audit contact sheets. Can instructions at seed 42 selected the bottle; a position swap toppled the can. Seed 43 bottle placement failed.
- Removed the simulator name from user-facing copy per the user's sponsorship preference; the visible label is NVIDIA GR00T.
- Seed 44 repeat `20261017-141705-89f1b9` reproduced the same settled bottle position, with a different spectator angle. Warm rollout took 24.62 seconds for 20 seconds of simulation.
- Verified front/back/top, drag orbit, and zoom through Chrome. Compared completed-scene state before and after top/zoom: same step and identical object positions, changed image, requested camera parameters applied. Saved `artifacts/camera-test-result.json`.
- Ten actual rollout recordings retained, including unsuccessful and user-stopped attempts. Local console remains running on port 8765.
