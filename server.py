"""Local command console. Modal credentials stay in the local SDK profile."""
import asyncio
import base64
import json
import os
import re
import secrets
from pathlib import Path
import threading
import time
import uuid

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).parent
RUNS = Path(os.environ.get("ROBOT_RUNS_DIR", ROOT / "artifacts" / "runs"))
RUNS.mkdir(parents=True, exist_ok=True)
api = FastAPI(title="Tabletop / GR-1 command lab")
api.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
api.mount("/recordings", StaticFiles(directory=RUNS), name="recordings")
state_lock = threading.Lock()
state = {"busy": False, "run_id": None, "status": "Ready to connect", "health": None}
events = []
sequence = 0
robot = None
persist_runs = lambda: None


def get_robot():
    global robot
    if robot is None:
        robot = modal.Cls.from_name("vast-gr1-tabletop", "RobotLab")()
    return robot


def publish(event):
    global sequence
    with state_lock:
        sequence += 1
        event = {**event, "seq": sequence, "timestamp": time.time()}
        events.append(event)
        del events[:-160]
        if event["type"] in ("status", "error"):
            state["status"] = event.get("message", "")
        if "health" in event:
            state["health"] = event["health"]
        if event["type"] == "frame":
            state["last_frame"] = event
        if event["type"] in ("result", "recording"):
            state[f"last_{event['type']}"] = event
        return event


@api.middleware("http")
async def local_origin(request: Request, call_next):
    web_token = os.environ.get("ROBOT_WEB_TOKEN")
    if web_token:
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not secrets.compare_digest(supplied, web_token):
            return JSONResponse(status_code=401, content={"detail": "Gateway authentication required"})
        return await call_next(request)
    origin = request.headers.get("origin")
    if request.method == "POST" and origin and origin not in ("http://127.0.0.1:8765", "http://localhost:8765"):
        return JSONResponse(status_code=403, content={"detail": "This console accepts local requests only"})
    return await call_next(request)


@api.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@api.get("/api/state")
def get_state():
    with state_lock:
        return {**state, "seq": sequence}


@api.get("/api/events")
async def event_stream(request: Request, after: int = 0):
    async def stream():
        cursor = max(after, int(request.headers.get("last-event-id", "0")))
        started = time.monotonic()
        while not await request.is_disconnected():
            with state_lock:
                fresh = [event for event in events if event["seq"] > cursor]
            for event in fresh:
                cursor = event["seq"]
                yield f"id: {cursor}\ndata: {json.dumps(event)}\n\n"
            if not fresh:
                yield ": keepalive\n\n"
            # Hosted connections reconnect with Last-Event-ID before either platform's timeout.
            if os.environ.get("ROBOT_WEB_TOKEN") and time.monotonic() - started > 25:
                break
            await asyncio.sleep(.12)
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class RunRequest(BaseModel):
    command: str = Field(default="Put the soda can into the cardboard box.", max_length=512)
    scene: str = Field(default="drinks", pattern="^(drinks|stock)$")
    seed: int = Field(default=42, ge=0, le=2147483647)
    max_steps: int = Field(default=400, ge=8, le=1000)
    swap_objects: bool = False


def goal_check(command, objects):
    """Recognize only literal one-object placement instructions; free text stays unscored."""
    command = command.removeprefix("unlocked_waist:").strip().lower()
    match = re.fullmatch(r"(?:put|place) (?:the )?(can|soda can|water bottle|bottled water|bottle) (?:in|into) (?:the )?(?:cardboard )?box[.!]?", command)
    if not match:
        return None
    label = "can" if "can" in match.group(1) else "bottled water"
    obj = next((item for item in objects.values() if item.get("label") == label), None)
    if obj is None:
        return None
    return {"object": label, "in_box": bool(obj.get("in_box")), "criterion": "object inside box"}


def execute(run_id, payload):
    folder = RUNS / run_id
    folder.mkdir()
    (folder / "request.json").write_text(json.dumps(payload, indent=2))
    try:
        publish({"type": "status", "message": "Connecting to Modal · loading policy if asleep", "run_id": run_id})
        with (folder / "events.jsonl").open("w") as log:
            for event in get_robot().rollout.remote_gen({**payload, "run_id": run_id}):
                if event["type"] == "result":
                    event["goal_check"] = goal_check(event["command"], event.get("objects", {}))
                if event["type"] == "frame":
                    jpeg = event.pop("jpeg")
                    (folder / "latest.jpg").write_bytes(jpeg)
                    event["image"] = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
                elif event["type"] == "recording":
                    (folder / "rollout.mp4").write_bytes(event.pop("mp4"))
                    event["url"] = f"/recordings/{run_id}/rollout.mp4"
                event["run_id"] = run_id
                publish(event)
                log.write(json.dumps({k: v for k, v in event.items() if k != "image"}) + "\n")
                log.flush()
                if event["type"] == "result":
                    (folder / "result.json").write_text(json.dumps(event, indent=2))
    except Exception as exc:
        publish({"type": "error", "message": f"{type(exc).__name__}: {exc}", "run_id": run_id})
    finally:
        try:
            persist_runs()
        except Exception:
            publish({"type": "error", "message": "The run completed, but its recording could not be saved.", "run_id": run_id})
        with state_lock:
            state["busy"] = False
        publish({"type": "idle", "run_id": run_id})


@api.post("/api/runs")
def start_run(payload: RunRequest):
    with state_lock:
        if state["busy"]:
            raise HTTPException(409, "A rollout is already running")
        run_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        state.update(busy=True, run_id=run_id, last_request=payload.model_dump())
    threading.Thread(target=execute, args=(run_id, payload.model_dump()), daemon=True).start()
    return {"run_id": run_id}


@api.post("/api/stop")
def stop_run():
    with state_lock:
        busy = state["busy"]
    if not busy:
        return {"stopping": False}
    return get_robot().stop.remote()


class CameraRequest(BaseModel):
    azimuth: float = Field(default=-90, ge=-1080, le=1080)
    elevation: float = Field(default=-17, ge=-80, le=25)
    distance: float = Field(default=1.8, ge=.8, le=4)


@api.post("/api/camera")
def set_camera(payload: CameraRequest):
    event = get_robot().set_camera.remote(payload.model_dump())
    if event.get("needs_scene"):
        return event
    jpeg = event.pop("jpeg", None)
    if jpeg:
        event["image"] = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        with state_lock:
            event["run_id"] = state["run_id"]
        publish(event)
    return {"ok": True, "camera": event.get("camera")}


@api.get("/api/runs")
def history():
    result = []
    for folder in sorted(RUNS.iterdir(), reverse=True):
        if not (folder / "request.json").exists():
            continue
        request = json.loads((folder / "request.json").read_text())
        record = {"run_id": folder.name, **request}
        if (folder / "result.json").exists():
            record.update(json.loads((folder / "result.json").read_text()))
            record["goal_check"] = goal_check(record.get("command", ""), record.get("objects", {}))
        if (folder / "rollout.mp4").exists():
            record["video"] = f"/recordings/{folder.name}/rollout.mp4"
        result.append(record)
    return result[:30]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(api, host="127.0.0.1", port=8765, timeout_graceful_shutdown=2)
