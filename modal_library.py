"""Durable video library with a private gateway for the public Vercel demos."""
from pathlib import Path

import modal

ROOT = Path(__file__).parent
app = modal.App("real-sim-physical-library")
library = modal.Volume.from_name("real-sim-physical-library", create_if_missing=True)
runs = modal.Volume.from_name("real-sim-physical-runs")
image = (modal.Image.from_registry("node:24-bookworm-slim", add_python="3.12")
         .apt_install("ffmpeg")
         .pip_install("fastapi==0.143.3", "httpx==0.28.1", "modal==1.6.2"))
for filename in ("server.mjs", "store.mjs", "vast.mjs", "hosted.mjs"):
    image = image.add_local_file(ROOT / "library" / filename, "/opt/demo/library/" + filename)
image = (image.add_local_dir(ROOT / "library/public", "/opt/demo/library/public")
         .add_local_dir(ROOT / "library/assets", "/opt/demo/library/assets")
         .add_local_file(ROOT / "web/library_gateway.py", "/opt/demo/library_gateway.py"))


@app.function(image=image, secrets=[modal.Secret.from_name("real-sim-physical-web")],
              volumes={"/library": library, "/runs": runs}, cpu=2, memory=2048,
              max_containers=1, scaledown_window=300, timeout=1800)
@modal.concurrent(max_inputs=40)
@modal.asgi_app()
def gateway():
    import os
    import sys
    sys.path.insert(0, "/opt/demo")
    from library_gateway import create_gateway
    return create_gateway(os.environ["ROBOT_WEB_TOKEN"], library, runs)
