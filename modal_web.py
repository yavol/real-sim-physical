"""Authenticated CPU gateway; the existing GPU policy stays private and unchanged."""
from pathlib import Path

import modal

ROOT = Path(__file__).parent
app = modal.App("real-sim-physical-web")
runs = modal.Volume.from_name("real-sim-physical-runs", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi==0.143.3", "modal==1.6.2")
    .env({"ROBOT_RUNS_DIR": "/runs"})
    .add_local_file(ROOT / "server.py", "/opt/demo/server.py")
    .add_local_dir(ROOT / "static", "/opt/demo/static")
)


@app.function(image=image, secrets=[modal.Secret.from_name("real-sim-physical-web")],
              volumes={"/runs": runs}, cpu=1, memory=1024, timeout=1800,
              scaledown_window=600, max_containers=1)
@modal.concurrent(max_inputs=60)
@modal.asgi_app()
def gateway():
    import sys
    sys.path.insert(0, "/opt/demo")
    import server
    server.persist_runs = runs.commit
    return server.api
