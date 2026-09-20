"""Run with python -m lab.server. This process never imports Relay's database."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from lab.catalog import catalog, resolve
from lab.models import RunConfig

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "data" / "lab"
STATIC = Path(__file__).parent / "static"
guard = threading.Lock()
active = None


def directory(id):
    try:
        if str(__import__("uuid").UUID(id)) != id:
            raise ValueError()
    except ValueError:
        raise HTTPException(404, "Run not found") from None
    path = RUNS / id
    if not path.is_dir():
        raise HTTPException(404, "Run not found")
    return path


def read_report(path):
    report = path / "report.json"
    if report.exists():
        data = json.loads(report.read_text(encoding="utf-8"))
    else:
        data = {"id": path.name, "status": "starting", "rows": [], "metrics": {}}
    # A crashed or interrupted parent must never leave an apparently running run.
    with guard:
        owned = active and active[0] == path.name and active[1].poll() is None
    if data["status"] in {"starting", "running", "draining"} and not owned:
        data["status"] = "interrupted"
        data["error"] = "The runner stopped before completing reconciliation. Partial results are preserved."
    return data


@asynccontextmanager
async def lifespan(app):
    yield
    with guard:
        current = active
    if current and current[1].poll() is None:
        (RUNS / current[0] / "stop").touch()
        current[1].stdin.close()
        # Producers stop; in-flight gates get their normal deadline and drain.
        await asyncio.to_thread(current[1].wait, 130)


app = FastAPI(title="Relay Lab", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])


@app.middleware("http")
async def local_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        return JSONResponse({"detail": "Open the lab directly on this local address."}, status_code=403)
    if request.method in {"POST", "PUT", "DELETE"}:
        if not request.headers.get("content-type", "").startswith("application/json"):
            return JSONResponse({"detail": "Send JSON from the lab interface."}, status_code=415)
        body = await request.body()
        if len(body) > 65536:
            return JSONResponse({"detail": "Keep a scenario under 64 KB."}, status_code=413)
    return await call_next(request)


@app.get("/api/catalog")
def get_catalog():
    return {"scenarios": catalog(), "limits": {"actions": 10000, "concurrency": 256, "live_actions": 25},
            "runs_directory": str(RUNS)}


@app.get("/api/runs")
def list_runs():
    paths = sorted(RUNS.glob("*/config.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]
    return [{k: v for k, v in read_report(p.parent).items() if k not in {"rows", "incidents", "samples", "config"}} for p in paths]


@app.post("/api/runs", status_code=202)
def start(config: RunConfig):
    global active
    try:
        resolve(config)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    with guard:
        if active and active[1].poll() is None:
            raise HTTPException(409, "A run is still active. Stop it and wait for its pending requests to finish.")
        id = str(uuid4())
        path = RUNS / id
        path.mkdir(parents=True)
        (path / "config.json").write_text(config.model_dump_json(indent=2), encoding="utf-8")
        with (path / "runner.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([sys.executable, "-m", "lab.runner", "--run", str(path), "--managed"], cwd=ROOT,
                stdin=subprocess.PIPE, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        active = (id, process)
    return {"id": id}


@app.get("/api/runs/{id}")
def get_run(id: str, offset: int = 0, limit: int = 100):
    data = read_report(directory(id))
    data["row_count"] = len(data["rows"])
    data["rows"] = data["rows"][max(0, offset):max(0, offset) + min(max(limit, 1), 200)]
    return data


@app.get("/api/runs/{id}/evidence/{index}")
def evidence(id: str, index: int):
    path = directory(id) / "evidence" / f"{index}.json"
    if not path.is_file():
        raise HTTPException(404, "Evidence is saved after the run finishes.")
    return FileResponse(path, media_type="application/json")


@app.post("/api/runs/{id}/stop")
def stop_run(id: str):
    path = directory(id)
    (path / "stop").touch()
    return {"status": "stopping", "detail": "No new actions will start. In-flight gates can take up to 60 seconds to settle."}


@app.get("/api/runs/{id}/export")
def export(id: str):
    return JSONResponse(read_report(directory(id)), headers={"Content-Disposition": f'attachment; filename="relay-lab-{id}.json"'})


app.mount("/", StaticFiles(directory=STATIC, html=True), name="ui")

if __name__ == "__main__":
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8010)
    uvicorn.run(app, host="127.0.0.1", port=parser.parse_args().port)
