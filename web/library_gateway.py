"""Private streaming adapter for the durable Node video library."""
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

ORIGIN = "https://real-sim-physical.vercel.app"
ROUTE = re.compile(r"^/api/library/(?:config|videos|videos/[a-z0-9-]{8,64}(?:/(?:stream|thumbnail|session|download))?|vast/(?:connect|videos|search|vast-[a-f0-9]+/stream))$")


def verify_ticket(encoded, secret, pathname, method, now=None):
    now = int(time.time() * 1000) if now is None else now
    try:
        payload, digest = encoded.split(".")
        expected = hmac.new(secret.encode(), ("library-ticket." + payload).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(digest, expected):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if data["path"] != pathname or not now < data["exp"] <= now + 601_000:
            return None
        if data["method"] != method and not (data["method"] == "GET" and method == "HEAD"):
            return None
        if not re.fullmatch(r"[a-f0-9]{32}", data.get("nonce", "")):
            return None
        return data
    except (ValueError, TypeError, KeyError):
        return None


def create_gateway(secret, volume, runs):
    class PersistenceHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/persist":
                self.send_error(404)
                return
            try:
                volume.commit()
                self.send_response(204)
            except Exception:
                self.send_response(503)
            self.end_headers()

        def log_message(self, *args):
            pass

    persistence = HTTPServer(("127.0.0.1", 8792), PersistenceHandler)
    threading.Thread(target=persistence.serve_forever, daemon=True).start()
    worker = subprocess.Popen(["node", "/opt/demo/library/hosted.mjs"])
    for _ in range(150):
        try:
            if httpx.get("http://127.0.0.1:8791/api/library/config", timeout=1, trust_env=False).status_code == 200:
                break
        except httpx.HTTPError:
            if worker.poll() is not None:
                raise RuntimeError("Library worker exited during startup.")
            time.sleep(.2)
    else:
        raise RuntimeError("Library worker did not become ready.")

    def refresh_runs():
        while True:
            time.sleep(15)
            try:
                runs.reload()
            except Exception:
                pass  # A file still being read can be refreshed on the next pass.
            try:
                volume.reload()
            except Exception:
                pass  # Active uploads keep their current filesystem snapshot.
    threading.Thread(target=refresh_runs, daemon=True).start()
    used = {}
    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @web.middleware("http")
    async def access(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin != ORIGIN:
            return JSONResponse({"error": "Origin is not allowed."}, status_code=403)
        cors = {"Access-Control-Allow-Origin": ORIGIN, "Vary": "Origin", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition"}
        if request.method == "OPTIONS":
            return Response(status_code=204, headers={**cors, "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH", "Access-Control-Allow-Headers": "Content-Type, Range", "Access-Control-Max-Age": "600"})
        if not ROUTE.fullmatch(request.url.path):
            return JSONResponse({"error": "Not found."}, status_code=404, headers=cors)
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not hmac.compare_digest(supplied, secret):
            ticket = verify_ticket(request.query_params.get("ticket", ""), secret, request.url.path, request.method)
            if ticket is None:
                return JSONResponse({"error": "Library access required."}, status_code=401, headers=cors)
            if request.method == "POST":
                now = int(time.time() * 1000)
                for nonce, expiry in list(used.items()):
                    if expiry <= now:
                        del used[nonce]
                if ticket["nonce"] in used:
                    return JSONResponse({"error": "Request a fresh upload link."}, status_code=409, headers=cors)
                if request.url.path.endswith("/videos") and request.query_params.get("filename") != ticket.get("filename"):
                    return JSONResponse({"error": "Upload filename does not match."}, status_code=400, headers=cors)
                try:
                    size = int(request.headers.get("content-length", "0"))
                except ValueError:
                    size = 0
                if not size or size != ticket.get("bytes") or size > 300 * 1024 * 1024:
                    return JSONResponse({"error": "Upload size does not match."}, status_code=413, headers=cors)
                used[ticket["nonce"]] = ticket["exp"]
        response = await call_next(request)
        for key, value in cors.items():
            response.headers[key] = value
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @web.api_route("/api/library/{route:path}", methods=["GET", "HEAD", "POST", "PATCH"])
    async def forward(request: Request, route: str):
        parameters = [(key, value) for key, value in request.query_params.multi_items() if key != "ticket"]
        target = httpx.URL("http://127.0.0.1:8791" + request.url.path, params=parameters)
        headers = {key: request.headers[key] for key in ("content-type", "content-length", "range") if key in request.headers}
        client = httpx.AsyncClient(timeout=httpx.Timeout(620, connect=5), trust_env=False)
        try:
            upstream = await client.send(client.build_request(request.method, target, headers=headers, content=request.stream() if request.method in ("POST", "PATCH") else None), stream=True)
        except httpx.HTTPError:
            await client.aclose()
            return JSONResponse({"error": "The video library is temporarily unavailable."}, status_code=502)
        copied = {key: value for key, value in upstream.headers.items() if key.lower() in {"content-type", "content-length", "content-range", "accept-ranges", "content-disposition"}}
        if request.method in ("POST", "PATCH"):
            data = await upstream.aread()
            await upstream.aclose()
            await client.aclose()
            return Response(data, status_code=upstream.status_code, headers=copied)

        async def content():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()
        return StreamingResponse(content(), status_code=upstream.status_code, headers=copied)

    return web
