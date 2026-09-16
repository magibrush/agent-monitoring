import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, delete
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.connectors import sync_connection, inspect_source, source_root
from backend.providers import PROVIDERS, default_path
from backend.db import ChatSession, Checkpoint, Event, Connection, ROOT, SessionLocal, now

lock = threading.RLock()
logger = logging.getLogger(__name__)


def synchronize(connection_id=None):
    with lock, SessionLocal() as db:
        query = select(Connection).where(Connection.provider.in_(PROVIDERS), Connection.enabled.is_(True))
        if connection_id:
            query = query.where(Connection.id == connection_id)
        ids = list(db.scalars(query.with_only_columns(Connection.id)))
        for id_ in ids:
            connection = db.get(Connection, id_)
            try:
                sync_connection(db, connection)
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
    allowed_origins = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"}
    # Also support the built UI served on another loopback port.
    if request.url.hostname in {"localhost", "127.0.0.1", "::1"}:
        allowed_origins.add(str(request.base_url).rstrip("/"))
    if origin and origin not in allowed_origins:
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
        counts = dict(db.execute(select(ChatSession.connection_id, func.count()).group_by(ChatSession.connection_id)).all())
        return [{**serialize(c), "session_count": counts.get(c.id, 0)} for c in db.scalars(select(Connection).where(Connection.provider.in_(PROVIDERS)).order_by(Connection.created_at))]


@app.get("/api/config")
def config():
    root = default_path("codex")
    candidates = [("codex", root), ("codex", Path.home() / ".codex" / "sessions")]
    candidates += [(adapter, path.parent / "archived_sessions") for adapter, path in list(candidates)]
    candidates += [("claude_code", default_path("claude_code")),
                   ("claude_code", Path.home() / ".claude" / "projects")]
    with SessionLocal() as db:
        candidates += [(PROVIDERS[c.provider].adapter, Path(c.path)) for c in db.scalars(
            select(Connection).where(Connection.provider.in_(PROVIDERS), Connection.path.is_not(None)))]
    sources = []
    seen = set()
    for adapter, candidate in candidates:
        path = str(candidate.expanduser().resolve())
        key = (adapter, path.casefold())
        if key in seen:
            continue
        seen.add(key)
        if not candidate.is_dir():
            continue
        info = {"path": path, "adapter": adapter, "archived": adapter == "codex" and candidate.name == "archived_sessions"}
        try:
            sources.append({**info, **inspect_source(path, adapter)})
        except (OSError, ValueError) as exc:
            sources.append({**info, "error": str(exc), "counts": {}})
    return {"codex_path": str(root), "codex_available": root.is_dir(), "providers": [
        {"id": id_, "label": spec.label, "default_path": str(default_path(id_)), "available": default_path(id_).is_dir(), "source": spec.source}
        for id_, spec in PROVIDERS.items()
    ], "sources": sources}


class ConnectionInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider: str
    path: str | None = None

    @field_validator("provider")
    @classmethod
    def supported_provider(cls, value):
        if value not in PROVIDERS:
            raise ValueError("Unsupported integration")
        return value


@app.post("/api/connections", status_code=201)
def create_connection(body: ConnectionInput):
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Connection name is required.")
    if not body.path or not Path(body.path).expanduser().is_dir():
        raise HTTPException(422, "Choose an existing local sessions directory.")
    path = str(source_root(body.path, body.provider))
    with lock, SessionLocal() as db:
        if path and db.scalar(select(Connection.id).where(Connection.path == path, Connection.provider == body.provider)):
            raise HTTPException(409, "This directory is already connected for this integration.")
        connection = Connection(name=name, provider=body.provider, path=path, status="waiting")
        db.add(connection)
        db.commit()
        return serialize(connection)


class SourceInput(BaseModel):
    provider: str
    path: str


@app.post("/api/connections/check")
def check_source(body: SourceInput):
    if body.provider not in PROVIDERS:
        raise HTTPException(422, "Unsupported integration")
    try:
        return inspect_source(body.path, body.provider)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc))


class ConnectionUpdate(BaseModel):
    enabled: bool


@app.delete("/api/connections/{id_}")
def delete_connection(id_: str):
    # Same lock as collection: no batch can recreate records after removal.
    # All database deletions commit together; source files are never opened.
    with lock, SessionLocal() as db:
        connection = db.get(Connection, id_)
        if not connection or connection.provider not in PROVIDERS:
            raise HTTPException(404, "Connection not found.")
        sessions = select(ChatSession.id).where(ChatSession.connection_id == id_)
        db.execute(delete(Checkpoint).where(Checkpoint.connection_id == id_))
        db.execute(delete(Event).where(Event.session_id.in_(sessions)))
        db.execute(delete(ChatSession).where(ChatSession.connection_id == id_))
        db.delete(connection)
        db.commit()
    return {"deleted": id_}


@app.patch("/api/connections/{id_}")
def update_connection(id_: str, body: ConnectionUpdate):
    with lock, SessionLocal() as db:
        connection = db.get(Connection, id_)
        if not connection or connection.provider not in PROVIDERS:
            raise HTTPException(404, "Connection not found.")
        connection.enabled = body.enabled
        connection.status = "waiting" if body.enabled else "paused"
        db.commit()
        return serialize(connection)


@app.post("/api/connections/{id_}/sync")
def sync(id_: str):
    with SessionLocal() as db:
        c = db.get(Connection, id_)
        if not c or c.provider not in PROVIDERS:
            raise HTTPException(404, "Connection not found.")
        if not c.enabled:
            raise HTTPException(409, "Enable the connection to sync.")
    synchronize(id_)
    with SessionLocal() as db:
        return serialize(db.get(Connection, id_))


from backend.analytics import router
app.include_router(router)


dist = ROOT / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
