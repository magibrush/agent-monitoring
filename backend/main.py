import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, delete, or_
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.connectors import sync_connection, inspect_source, source_root
from backend.providers import PROVIDERS, default_path
from backend.db import ChatSession, Checkpoint, Event, HookObservation, Connection, SafetyEvaluation, SafetyAttempt, ROOT, SessionLocal, now
from backend import hooks

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
                connection.error = None
                sync_connection(db, connection)
                connection.status = "watching"
                connection.last_sync = now()
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
    async def watch_hooks():
        while True:
            try:
                await asyncio.to_thread(synchronize_hooks)
            except Exception:
                logger.exception("Hook collector cycle failed")
            await asyncio.sleep(0.1)
    async def watch():
        while True:
            try:
                await asyncio.to_thread(synchronize)
            except Exception:
                logger.exception("Collector cycle failed")
            await asyncio.sleep(3)
    task = asyncio.create_task(watch())
    hook_task = asyncio.create_task(watch_hooks())
    yield
    task.cancel()
    hook_task.cancel()
    await asyncio.gather(task, hook_task, return_exceptions=True)


def synchronize_hooks():
    with lock, SessionLocal() as db:
        for connection in db.scalars(select(Connection).where(Connection.provider.in_(PROVIDERS),
                or_(Connection.enabled.is_(True), Connection.gate_enabled.is_(True)), Connection.hooks_enabled.is_(True))).all():
            hooks.collect(db, connection)
        from backend.blocking import dispatch
        dispatch(db)


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
    return {"status": "ok", "mode": "per_connection", "poll_seconds": 3, "hook_poll_seconds": 0.1}


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
        (hooks.queue_path(connection) / "enabled").unlink(missing_ok=True)
        (hooks.queue_path(connection) / "gate-enabled").unlink(missing_ok=True)
        evaluations = select(SafetyEvaluation.id).where(SafetyEvaluation.event_id.in_(select(Event.id).where(Event.session_id.in_(sessions))))
        db.execute(delete(SafetyAttempt).where(SafetyAttempt.evaluation_id.in_(evaluations)))
        db.execute(delete(SafetyEvaluation).where(SafetyEvaluation.id.in_(evaluations)))
        db.execute(delete(HookObservation).where(HookObservation.connection_id == id_))
        db.execute(delete(Checkpoint).where(Checkpoint.connection_id == id_))
        db.execute(delete(Event).where(Event.session_id.in_(sessions)))
        db.execute(delete(ChatSession).where(ChatSession.connection_id == id_))
        db.delete(connection)
        db.commit()
    return {"deleted": id_}


@app.get("/api/connections/{id_}/hooks")
def hook_setup(id_: str, gate_enabled: bool | None = None):
    with SessionLocal() as db:
        c = db.get(Connection, id_)
        if not c or c.provider not in PROVIDERS:
            raise HTTPException(404, "Connection not found.")
        if gate_enabled is not None:
            c.gate_enabled = gate_enabled
        try:
            target, snippet = hooks.setup(c)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        return {"path": str(target), "config": snippet, "mode": "blocking" if c.gate_enabled else "observation",
                "instructions": "Restart the provider session after setup. In Codex, use /hooks to review and trust the handler. Installed settings do not prove enforcement: inspect a blocking request and its gate receipt to verify delivery."}


class HookUpdate(BaseModel):
    enabled: bool
    gate_enabled: bool | None = None


@app.patch("/api/connections/{id_}/hooks")
def update_hooks(id_: str, body: HookUpdate):
    with lock, SessionLocal() as db:
        c = db.get(Connection, id_)
        if not c or c.provider not in PROVIDERS:
            raise HTTPException(404, "Connection not found.")
        try:
            if body.gate_enabled is not None:
                c.gate_enabled = body.gate_enabled and body.enabled
            hooks.configure(c, body.enabled)
        except (OSError, ValueError) as exc:
            raise HTTPException(422, str(exc))
        db.commit()
        return serialize(c)


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


@app.get("/api/safety")
def safety_status():
    from backend.safety import status
    with SessionLocal() as db:
        return status(db)


@app.get("/api/safety/evaluations/{id_}")
def safety_evaluation(id_: str):
    from backend.safety import public
    with SessionLocal() as db:
        evaluation = db.get(SafetyEvaluation, id_)
        if not evaluation:
            raise HTTPException(404, "Evaluation not found.")
        return {**public(evaluation), "snapshot": evaluation.snapshot,
                "attempt_history": [serialize(a) for a in db.scalars(select(SafetyAttempt).where(SafetyAttempt.evaluation_id == id_).order_by(SafetyAttempt.started_at))]}


@app.post("/api/safety/evaluations/{id_}/retry", status_code=201)
def retry_evaluation(id_: str):
    from backend.safety import public, MAX_PENDING
    from backend.safety_policy import POLICY_VERSION, MODEL
    from uuid import uuid4
    with lock, SessionLocal() as db:
        original = db.get(SafetyEvaluation, id_)
        if not original:
            raise HTTPException(404, "Evaluation not found.")
        if original.status not in {"failed", "skipped"}:
            raise HTTPException(409, "Only failed evaluations can be reviewed again.")
        pending = db.scalar(select(func.count()).select_from(SafetyEvaluation).where(SafetyEvaluation.status.in_(["queued", "running"])))
        if pending >= MAX_PENDING:
            raise HTTPException(429, "Evaluation queue is full.")
        # Review historical evidence, never revive the old hook authorization.
        job = SafetyEvaluation(event_id=original.event_id, input_hash=original.input_hash, request_key=str(uuid4()),
            mode="shadow", policy_version=POLICY_VERSION, model=MODEL, snapshot=original.snapshot,
            rules=original.rules, diagnostics={"retry_of": original.id})
        db.add(job)
        db.commit()
        return public(job)


class HumanReview(BaseModel):
    decision: Literal["approve", "deny"]
    input_hash: str = Field(min_length=64, max_length=64)


@app.post("/api/safety/evaluations/{id_}/review")
def review_evaluation(id_: str, body: HumanReview):
    from backend.safety import human_review, public
    with lock, SessionLocal() as db:
        if not db.get(SafetyEvaluation, id_):
            raise HTTPException(404, "Evaluation not found.")
        if not human_review(db, id_, body.decision, body.input_hash):
            raise HTTPException(409, "This request expired, was already resolved, or is not awaiting approval. It cannot be resumed; submit a new tool request.")
        return public(db.get(SafetyEvaluation, id_))


from backend.analytics import router
app.include_router(router)


dist = ROOT / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
