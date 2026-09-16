import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

ROOT = Path(__file__).resolve().parents[1]


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class Connection(Base):
    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(20))
    path: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(30), default="waiting")
    error: Mapped[str | None] = mapped_column(Text)
    last_sync: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    hooks_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    hook_last_seen: Mapped[str | None] = mapped_column(String(40))
    hook_error: Mapped[str | None] = mapped_column(Text)


class ChatSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (UniqueConstraint("connection_id", "external_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    connection_id: Mapped[str] = mapped_column(ForeignKey("connections.id"), index=True)
    external_id: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40), index=True)
    source: Mapped[str] = mapped_column(String(50))
    session_type: Mapped[str] = mapped_column(String(30), default="conversation", index=True)
    parent_thread_id: Mapped[str | None] = mapped_column(String(200))


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("session_id", "external_id"), Index("ix_events_session_time", "session_id", "occurred_at"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    external_id: Mapped[str] = mapped_column(String(250))
    kind: Mapped[str] = mapped_column(String(30), index=True)
    role: Mapped[str] = mapped_column(String(30))
    text: Mapped[str] = mapped_column(Text)
    tool_name: Mapped[str | None] = mapped_column(String(200))
    action_category: Mapped[str] = mapped_column(String(30), default="other", index=True)
    tool_call_id: Mapped[str | None] = mapped_column(String(250), index=True)
    turn_id: Mapped[str | None] = mapped_column(String(250))
    occurred_at: Mapped[str] = mapped_column(String(40), index=True)
    ingested_at: Mapped[str] = mapped_column(String(40), default=now)
    payload: Mapped[dict] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    transcript_seen: Mapped[bool] = mapped_column(Boolean, default=True)
    hook_state: Mapped[str | None] = mapped_column(String(30))
    hook_seen_at: Mapped[str | None] = mapped_column(String(40))


class HookObservation(Base):
    __tablename__ = "hook_observations"
    __table_args__ = (UniqueConstraint("connection_id", "fingerprint"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey("connections.id"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), index=True)
    phase: Mapped[str] = mapped_column(String(40))
    received_at: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)


class Checkpoint(Base):
    __tablename__ = "checkpoints"
    __table_args__ = (UniqueConstraint("connection_id", "path"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey("connections.id"))
    path: Mapped[str] = mapped_column(Text)
    offset: Mapped[int] = mapped_column(Integer, default=0)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("sessions.id"))
    prefix_hash: Mapped[str | None] = mapped_column(String(64))


def make_engine(url=None):
    url = url or os.getenv("DATABASE_URL", "sqlite:///" + (ROOT / "data/monitor.db").as_posix())
    if url.startswith("sqlite"):
        (ROOT / "data").mkdir(exist_ok=True)
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {})
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def configure(db, _):
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=30000")
    return engine


engine = make_engine()
SessionLocal = sessionmaker(engine, expire_on_commit=False)
