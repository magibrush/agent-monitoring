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
    gate_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
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


class TokenUsage(Base):
    __tablename__ = "token_usage"
    __table_args__ = (UniqueConstraint("session_id", "external_id"), Index("ix_token_usage_session_time", "session_id", "occurred_at"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    external_id: Mapped[str] = mapped_column(String(250))
    occurred_at: Mapped[str] = mapped_column(String(40))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)


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
    record_counts: Mapped[dict | None] = mapped_column(JSON)
    tail_hash: Mapped[str | None] = mapped_column(String(64))


class SafetyEvaluation(Base):
    __tablename__ = "safety_evaluations"
    __table_args__ = (UniqueConstraint("event_id", "input_hash", "request_key", name="uq_safety_request"),
                     Index("ix_safety_jobs", "status", "available_at"), Index("ix_safety_mode_created", "mode", "created_at"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), index=True)
    input_hash: Mapped[str] = mapped_column(String(64))
    request_key: Mapped[str] = mapped_column(String(36), default="")
    mode: Mapped[str] = mapped_column(String(20), default="shadow")
    deadline: Mapped[str | None] = mapped_column(String(40))
    started_at: Mapped[str | None] = mapped_column(String(40))
    decision: Mapped[str | None] = mapped_column(String(20))
    decision_at: Mapped[str | None] = mapped_column(String(40))
    returned_at: Mapped[str | None] = mapped_column(String(40))
    diagnostics: Mapped[dict | None] = mapped_column(JSON)
    human_decision: Mapped[str | None] = mapped_column(String(20))
    reviewed_at: Mapped[str | None] = mapped_column(String(40))
    policy_version: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(100))
    debug_result: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(30), default="queued")
    snapshot: Mapped[dict] = mapped_column(JSON)
    rules: Mapped[dict] = mapped_column(JSON)
    gate: Mapped[dict | None] = mapped_column(JSON)
    result: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[str | None] = mapped_column(String(40))
    available_at: Mapped[str] = mapped_column(String(40), default=now)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    completed_at: Mapped[str | None] = mapped_column(String(40))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    admitted_at: Mapped[str | None] = mapped_column(String(40))
    first_started_at: Mapped[str | None] = mapped_column(String(40))
    review_ready_at: Mapped[str | None] = mapped_column(String(40))
    published_at: Mapped[str | None] = mapped_column(String(40))
    rules_ms: Mapped[int | None] = mapped_column(Integer)
    usage: Mapped[dict | None] = mapped_column(JSON)


class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    connection_id: Mapped[str] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20), default="concern")
    severity: Mapped[str] = mapped_column(String(12), default="medium", index=True)
    status: Mapped[str] = mapped_column(String(20), default="new", index=True)
    resolution: Mapped[str | None] = mapped_column(String(40))
    signature: Mapped[str | None] = mapped_column(String(64), index=True)
    grouping_reason: Mapped[str] = mapped_column(Text)
    previous_id: Mapped[str | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"))
    revision: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    last_activity_at: Mapped[str] = mapped_column(String(40), default=now, index=True)
    resolved_at: Mapped[str | None] = mapped_column(String(40))


class IncidentAnalysis(Base):
    __tablename__ = "incident_analyses"
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), primary_key=True)
    requested_revision: Mapped[int] = mapped_column(Integer, default=0)
    analyzed_revision: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    evidence: Mapped[dict | None] = mapped_column(JSON)
    result: Mapped[dict | None] = mapped_column(JSON)
    model: Mapped[str] = mapped_column(String(100), default="claude-haiku-4-5-20251001")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[str | None] = mapped_column(String(36))
    lease_until: Mapped[str | None] = mapped_column(String(40))
    available_at: Mapped[str] = mapped_column(String(40), default=now)
    analyzed_at: Mapped[str | None] = mapped_column(String(40))
    error: Mapped[str | None] = mapped_column(Text)
    usage: Mapped[dict | None] = mapped_column(JSON)


class IncidentLink(Base):
    __tablename__ = "incident_links"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    evaluation_id: Mapped[str | None] = mapped_column(ForeignKey("safety_evaluations.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(20), default="automatic")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class IncidentActivity(Base):
    __tablename__ = "incident_activity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(String(40), default="local operator")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class IncidentCandidate(Base):
    __tablename__ = "incident_candidates"
    evaluation_id: Mapped[str] = mapped_column(ForeignKey("safety_evaluations.id", ondelete="CASCADE"), primary_key=True)
    signature: Mapped[str | None] = mapped_column(String(64), index=True)
    occurred_at: Mapped[str] = mapped_column(String(40), index=True)
    handled: Mapped[bool] = mapped_column(Boolean, default=False)


class IncidentMonitor(Base):
    __tablename__ = "incident_monitor"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled_at: Mapped[str] = mapped_column(String(40), default=now)


class PolicyVersion(Base):
    __tablename__ = "policy_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    rules: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    previewed_at: Mapped[str | None] = mapped_column(String(40))
    preview_result: Mapped[dict | None] = mapped_column(JSON)
    trial_started_at: Mapped[str | None] = mapped_column(String(40))


class PolicyState(Base):
    __tablename__ = "policy_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    active_id: Mapped[int | None] = mapped_column(ForeignKey("policy_versions.id"))
    trial_id: Mapped[int | None] = mapped_column(ForeignKey("policy_versions.id"))
    draft_id: Mapped[int | None] = mapped_column(ForeignKey("policy_versions.id"))
    paused_id: Mapped[int | None] = mapped_column(ForeignKey("policy_versions.id"))


class PolicyChange(Base):
    __tablename__ = "policy_changes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version_id: Mapped[int | None] = mapped_column(ForeignKey("policy_versions.id"))
    action: Mapped[str] = mapped_column(String(30))
    actor: Mapped[str] = mapped_column(String(40), default="local operator")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class SafetyWorker(Base):
    __tablename__ = "safety_workers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    heartbeat_at: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(40))


class SafetyDebugSettings(Base):
    __tablename__ = "safety_debug_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    result: Mapped[str] = mapped_column(String(10), default="review")
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class SafetyAttempt(Base):
    __tablename__ = "safety_attempts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    evaluation_id: Mapped[str] = mapped_column(ForeignKey("safety_evaluations.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[str] = mapped_column(String(40))
    completed_at: Mapped[str | None] = mapped_column(String(40))
    error: Mapped[str | None] = mapped_column(Text)
    diagnostics: Mapped[dict | None] = mapped_column(JSON)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    usage: Mapped[dict | None] = mapped_column(JSON)


def make_engine(url=None):
    from backend import runtime
    if url is None and runtime.DEMO:
        runtime.DEMO_DB.parent.mkdir(parents=True, exist_ok=True)
        url = runtime.demo_database_url()
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
