import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.connectors import sync_codex
from backend.db import Connection, ROOT, SessionLocal, now

lock = threading.RLock()
logger = logging.getLogger(__name__)


def synchronize(connection_id=None):
    with lock, SessionLocal() as db:
        query = select(Connection).where(Connection.provider == "codex", Connection.enabled.is_(True))
        if connection_id:
            query = query.where(Connection.id == connection_id)
        ids = list(db.scalars(query.with_only_columns(Connection.id)))
        for id_ in ids:
            connection = db.get(Connection, id_)
            try:
                sync_codex(db, connection)
                connection.status, connection.error, connection.last_sync = "watching", None, now()
                db.commit()
            except Exception as exc:
                db.rollback()
                connection = db.get(Connection, id_)
                connection.status = "error"
                connection.error = str(exc) if isinstance(exc, (ValueError, OSError)) else "Sync failed. See backend logs."
                db.commit()
                logger.warning("Connector sync failed for %s: %s", id_, type(exc).__name__)


@asynccontextmanager
async def lifespan(app):
    async def watch():
        while True:
            try:
                await asyncio.to_thread(synchronize)
            except Exception:
                logger.exception("Collector cycle failed")
            await asyncio.sleep(3)
    task = asyncio.create_task(watch())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Relay · Agent monitoring", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])


@app.middleware("http")
async def local_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"}:
        return JSONResponse({"detail": "Only the local monitoring UI can access this API."}, status_code=403)
    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return JSONResponse({"detail": "Invalid content length."}, status_code=400)
    if content_length > 1024 * 1024:
        return JSONResponse({"detail": "Request exceeds 1 MB."}, status_code=413)
    return await call_next(request)


def serialize(model):
    return {column.name: getattr(model, column.name) for column in model.__table__.columns}


@app.get("/api/health")
def health():
    with SessionLocal() as db:
        db.execute(select(Connection.id).limit(1))
    return {"status": "ok", "mode": "observation", "poll_seconds": 3}


@app.get("/api/connections")
def connections():
    with SessionLocal() as db:
        return [serialize(c) for c in db.scalars(select(Connection).where(Connection.provider == "codex").order_by(Connection.created_at))]


@app.get("/api/config")
def config():
    root = Path(os.getenv("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions"
    return {"codex_path": str(root), "codex_available": root.is_dir()}


class ConnectionInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider: Literal["codex"]
    path: str | None = None


@app.post("/api/connections", status_code=201)
def create_connection(body: ConnectionInput):
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Connection name is required.")
    path = None
    if body.provider == "codex":
        if not body.path or not Path(body.path).expanduser().is_dir():
            raise HTTPException(422, "Choose an existing local Codex sessions directory.")
        path = str(Path(body.path).expanduser().resolve())
    with lock, SessionLocal() as db:
        if path and db.scalar(select(Connection.id).where(Connection.path == path, Connection.provider == "codex")):
            raise HTTPException(409, "This directory is already connected.")
        connection = Connection(name=name, provider=body.provider, path=path, status="waiting")
        db.add(connection)
        db.commit()
        return serialize(connection)


class ConnectionUpdate(BaseModel):
    enabled: bool


@app.patch("/api/connections/{id_}")
def update_connection(id_: str, body: ConnectionUpdate):
    with lock, SessionLocal() as db:
        connection = db.get(Connection, id_)
        if not connection or connection.provider != "codex":
            raise HTTPException(404, "Connection not found.")
        connection.enabled = body.enabled
        if connection.provider == "codex":
            connection.status = "waiting" if body.enabled else "paused"
        db.commit()
        return serialize(connection)


@app.post("/api/connections/{id_}/sync")
def sync(id_: str):
    with SessionLocal() as db:
        c = db.get(Connection, id_)
        if not c:
            raise HTTPException(404, "Connection not found.")
        if c.provider != "codex" or not c.enabled:
            raise HTTPException(409, "Enable a Codex connection to sync.")
    synchronize(id_)
    with SessionLocal() as db:
        return serialize(db.get(Connection, id_))


from backend.analytics import router
app.include_router(router)


dist = ROOT / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
