import asyncio
import logging
import threading
import sqlite3
import time
import traceback
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, delete, or_
from sqlalchemy.exc import OperationalError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.connectors import sync_connection, inspect_source, source_root
from backend.providers import PROVIDERS, default_path
from backend.db import ChatSession, Checkpoint, Event, HookObservation, Connection, SafetyEvaluation, SafetyAttempt, ROOT, SessionLocal, now
from backend import hooks
from backend import runtime
from backend.collection_control import collection, interrupt_collection, check_interrupted, ImportInterrupted

lock = threading.RLock()
hook_lock = threading.RLock()
logger = logging.getLogger(__name__)


def database_busy(exc):
    """Only SQLite lock contention is safe to retry as a transient failure."""
    return (isinstance(exc, OperationalError) and
            isinstance(exc.orig, sqlite3.OperationalError) and
            (getattr(exc.orig, "sqlite_errorcode", 0) & 0xff) in
            (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED))


def synchronize(connection_id=None):
    if runtime.DEMO:
        return
    if connection_id is None:
        with SessionLocal() as db:
            ids = list(db.scalars(select(Connection.id).where(
                Connection.provider.in_(PROVIDERS), Connection.enabled.is_(True))))
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="import") as executor:
            list(executor.map(synchronize, ids))
        return
    id_ = connection_id
    state = collection(id_)
    # Repeated requests must not queue duplicate imports for the same source.
    if state.stop.is_set() or not state.lock.acquire(blocking=False):
        return False
    try:
        for attempt in range(3):
            with SessionLocal() as db:
                db.info["import_stop"] = state.stop
                try:
                    check_interrupted(db)
                    connection = db.get(Connection, id_)
                    if connection is None or not connection.enabled:
                        break
                    # Do not acquire a write lock just to clear an old error
                    # before scanning the source files.
                    sync_connection(db, connection, batch_size=100)
                    check_interrupted(db)
                    connection.error = None
                    connection.status = "watching"
                    connection.last_sync = now()
                    db.commit()
                    break
                except ImportInterrupted:
                    db.rollback()
                    break
                except Exception as exc:
                    db.rollback()
                    busy = database_busy(exc)
                    if busy and attempt < 2:
                        logger.info("Sync database busy for %s; retrying (%s/2)", id_, attempt + 1)
                    else:
                        # Include the failing code location without dumping SQL
                        # parameters, which may contain private transcript text.
                        logger.error("Connector sync failed for %s: %s (sqlite=%s)\n%s",
                                     id_, type(exc).__name__,
                                     getattr(getattr(exc, "orig", None), "sqlite_errorname", "n/a"),
                                     "".join(traceback.format_tb(exc.__traceback__)))
                        connection = db.get(Connection, id_)
                        if connection is None:
                            break
                        connection.status = "error"
                        connection.error = ("Database is busy. Sync will retry automatically." if busy else
                                            str(exc) if isinstance(exc, (ValueError, OSError)) else
                                            f"Sync failed ({type(exc).__name__}). See backend logs.")
                        try:
                            db.commit()
                        except OperationalError as status_error:
                            db.rollback()
                            if not database_busy(status_error):
                                raise
                            logger.warning("Database still busy; could not save sync status for %s. Retrying next cycle.", id_)
                        break
            # Release the failed transaction before backing off. Checkpoints
            # from committed batches let a retry resume without duplicates.
            time.sleep(0.1 * (attempt + 1))
    finally:
        state.lock.release()


@asynccontextmanager
async def lifespan(app):
    if runtime.DEMO:
        yield
        return
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
    async def watch_incidents():
        from backend.incidents import synchronize as synchronize_incidents
        while True:
            try:
                await asyncio.to_thread(synchronize_incidents)
            except Exception:
                logger.exception("Incident grouping cycle failed")
            await asyncio.sleep(2)
    task = asyncio.create_task(watch())
    hook_task = asyncio.create_task(watch_hooks())
    incident_task = asyncio.create_task(watch_incidents())
    yield
    task.cancel()
    hook_task.cancel()
    incident_task.cancel()
    await asyncio.gather(task, hook_task, incident_task, return_exceptions=True)


def synchronize_hooks():
    if runtime.DEMO:
        return
    with hook_lock, SessionLocal() as db:
        from backend.blocking import dispatch
        dispatch(db)
        for connection in db.scalars(select(Connection).where(Connection.provider.in_(PROVIDERS),
                or_(Connection.enabled.is_(True), Connection.gate_enabled.is_(True)), Connection.hooks_enabled.is_(True))).all():
            hooks.collect(db, connection, limit=10)
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
    if runtime.DEMO and request.url.path.startswith("/api/"):
        from backend.demo import permitted_request
        if not permitted_request(request.method, request.url.path):
            return JSONResponse({"detail": "This is the synthetic demo. Connections, hooks, policies, and live evaluations are disabled. You can explore evidence, add incident notes, and resolve sample incidents."}, status_code=403)
    return await call_next(request)


def serialize(model):
    return {column.name: getattr(model, column.name) for column in model.__table__.columns}


@app.get("/api/health")
def health():
    with SessionLocal() as db:
        db.execute(select(Connection.id).limit(1))
    return {"status": "ok", "mode": "demo" if runtime.DEMO else "per_connection", "demo": runtime.DEMO, "poll_seconds": 3, "hook_poll_seconds": 0.1}


@app.post("/api/demo/reset")
def reset_demo():
    if not runtime.DEMO:
        raise HTTPException(404, "Demo mode is not enabled.")
    from backend.demo import seed
    from backend.incidents import lock as incident_lock
    with lock, incident_lock, SessionLocal() as db:
        seed(db)
    return {"reset": True}


@app.get("/api/connections")
def connections():
    with SessionLocal() as db:
        counts = dict(db.execute(select(ChatSession.connection_id, func.count()).group_by(ChatSession.connection_id)).all())
        return [{**serialize(c), "session_count": counts.get(c.id, 0)} for c in db.scalars(select(Connection).where(Connection.provider.in_(PROVIDERS)).order_by(Connection.created_at))]


@app.get("/api/config")
def config():
    if runtime.DEMO:
        return {"codex_path": "", "codex_available": False, "providers": [], "sources": []}
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
    # Stop this import before deleting so it cannot recreate imported records.
    # All database deletions commit together; source files are never opened.
    from backend.incidents import lock as incident_lock
    with interrupt_collection(id_), lock, hook_lock, incident_lock, SessionLocal() as db:
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
    with interrupt_collection(id_), SessionLocal() as db:
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
    completed = synchronize(id_)
    with SessionLocal() as db:
        connection = db.get(Connection, id_)
        if connection is None:
            raise HTTPException(404, "Connection not found.")
        return {**serialize(connection), **({"status": "syncing"} if completed is False else {})}


@app.get("/api/safety")
def safety_status():
    from backend.safety import status
    with SessionLocal() as db:
        return status(db)


class SafetyDebugUpdate(BaseModel):
    enabled: bool = Field(strict=True)
    result: Literal["allow", "review", "deny"] = "review"


@app.put("/api/safety/debug")
def update_safety_debug(body: SafetyDebugUpdate):
    from backend.safety_debug import update as update_debug
    with SessionLocal() as db:
        return update_debug(db, body.enabled, body.result)


@app.get("/api/safety/evaluations/{id_}")
def safety_evaluation(id_: str):
    from backend.safety import public
    with SessionLocal() as db:
        evaluation = db.get(SafetyEvaluation, id_)
        if not evaluation:
            raise HTTPException(404, "Evaluation not found.")
        from backend.safety_metrics import timings
        attempts = list(db.scalars(select(SafetyAttempt).where(SafetyAttempt.evaluation_id == id_).order_by(SafetyAttempt.started_at)))
        return {**public(evaluation), "snapshot": evaluation.snapshot, "timings": timings(evaluation, attempts),
                "attempt_history": [serialize(a) for a in attempts]}


@app.post("/api/safety/evaluations/{id_}/retry", status_code=201)
def retry_evaluation(id_: str):
    from backend.safety import public, MAX_PENDING
    from backend.safety_policy import POLICY_VERSION, MODEL
    from uuid import uuid4
    from backend.safety_debug import selected_result
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
        debug_result = selected_result(db) if original.rules.get("decision") != "deny" else None
        job = SafetyEvaluation(event_id=original.event_id, input_hash=original.input_hash, request_key=str(uuid4()),
            mode="shadow", policy_version=POLICY_VERSION, model="debug" if debug_result else MODEL,
            debug_result=debug_result, snapshot=original.snapshot,
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
from backend.policies import router as policy_router
app.include_router(policy_router)
from backend.incidents import router as incident_router
app.include_router(incident_router)


dist = ROOT / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
