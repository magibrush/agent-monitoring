import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.connectors import sync_codex
from backend.db import ChatSession, Connection, Event, ROOT, SessionLocal, now

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


def filters(provider, connection, q, session_ids):
    conditions = [Connection.provider == "codex"]
    if provider:
        conditions.append(Connection.provider == provider)
    if connection:
        conditions.append(Connection.id == connection)
    if q:
        conditions.append(or_(ChatSession.title.icontains(q, autoescape=True), ChatSession.id.in_(select(Event.session_id).where(Event.text.icontains(q, autoescape=True)))))
    if session_ids:
        conditions.append(ChatSession.id.in_(session_ids.split(",")))
    return conditions


def cutoff(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat() if days else "0000"


@app.get("/api/sessions")
def sessions(provider: str = "", connection: str = "", q: str = "", session_ids: str = "", days: int = Query(0, ge=0, le=3650), sort: Literal["recent", "messages", "actions", "title"] = "recent", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    counts = select(Event.session_id, func.sum(case((Event.kind == "message", 1), else_=0)).label("messages"), func.sum(case((Event.kind == "tool_call", 1), else_=0)).label("actions")).where(Event.occurred_at >= cutoff(days)).group_by(Event.session_id).subquery()
    query = select(ChatSession, Connection.name, Connection.provider, func.coalesce(counts.c.messages, 0), func.coalesce(counts.c.actions, 0)).join(Connection).outerjoin(counts, counts.c.session_id == ChatSession.id).where(*filters(provider, connection, q, session_ids))
    if days:
        query = query.where(counts.c.session_id.is_not(None))
    ordering = {"recent": ChatSession.updated_at.desc(), "messages": func.coalesce(counts.c.messages, 0).desc(), "actions": func.coalesce(counts.c.actions, 0).desc(), "title": ChatSession.title.asc()}[sort]
    with SessionLocal() as db:
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        rows = db.execute(query.order_by(ordering, ChatSession.id).offset(offset).limit(limit)).all()
        return {"total": total, "items": [{**serialize(s), "connection_name": name, "provider": p, "messages": m, "actions": a} for s, name, p, m, a in rows]}


@app.get("/api/metrics")
def metrics(provider: str = "", connection: str = "", q: str = "", session_ids: str = "", days: int = Query(7, ge=0, le=3650)):
    time = cutoff(days)
    selected = select(ChatSession.id).join(Connection).where(*filters(provider, connection, q, session_ids))
    base = select(Event).where(Event.session_id.in_(selected), Event.occurred_at >= time).subquery()
    with SessionLocal() as db:
        counts = dict(db.execute(select(base.c.kind, func.count()).group_by(base.c.kind)).all())
        roles = dict(db.execute(select(base.c.role, func.count()).where(base.c.kind == "message").group_by(base.c.role)).all())
        daily = db.execute(select(func.substr(base.c.occurred_at, 1, 10), base.c.role, base.c.kind, func.count()).group_by(func.substr(base.c.occurred_at, 1, 10), base.c.role, base.c.kind)).all()
        active = db.scalar(select(func.count(func.distinct(base.c.session_id))))
        tools = db.execute(select(base.c.tool_name, func.count()).where(base.c.kind == "tool_call").group_by(base.c.tool_name).order_by(func.count().desc()).limit(6)).all()
        return {"sessions": active, "messages": counts.get("message", 0), "questions": roles.get("user", 0), "answers": roles.get("assistant", 0), "actions": counts.get("tool_call", 0), "daily": [{"day": d, "role": r, "kind": k, "count": n} for d, r, k, n in daily], "tools": [{"name": t or "Unknown tool", "count": n} for t, n in tools]}


@app.get("/api/sessions/{id_}/events")
def events(id_: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200), kind: str = "", q: str = ""):
    with SessionLocal() as db:
        session = db.get(ChatSession, id_)
        if not session or db.get(Connection, session.connection_id).provider != "codex":
            raise HTTPException(404, "Session not found.")
        query = select(Event).where(Event.session_id == id_)
        if kind:
            query = query.where(Event.kind == kind)
        if q:
            query = query.where(Event.text.icontains(q, autoescape=True))
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        rows = db.scalars(query.order_by(Event.occurred_at, Event.id).offset(offset).limit(limit))
        return {"session": serialize(session), "total": total, "items": [{k: v for k, v in serialize(e).items() if k != "payload"} for e in rows]}


dist = ROOT / "frontend/dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
