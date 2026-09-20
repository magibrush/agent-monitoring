"""Local investigations derived from persisted assessments, outside the gate path."""
import hashlib
import json
import ntpath
import posixpath
import threading
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select, text

from backend.db import (ChatSession, Connection, Event, Incident, IncidentActivity,
    IncidentCandidate, IncidentLink, IncidentMonitor, SafetyEvaluation, now)
from backend.providers import PROVIDERS

router = APIRouter(prefix="/api/safety/incidents")
lock = threading.RLock()
RESOLUTIONS = {"expected": "Expected activity", "policy": "Policy needs adjusting", "addressed": "Issue addressed", "other": "Other"}


def store():
    from backend.main import SessionLocal
    return SessionLocal()


def dump(row):
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


def log(db, incident, kind, text, actor="local operator"):
    db.add(IncidentActivity(incident_id=incident.id, kind=kind, text=text, actor=actor))


def get_incident(db, id_):
    row = db.get(Incident, id_)
    if not row or db.get(Connection, row.connection_id).provider not in PROVIDERS:
        raise HTTPException(404, "Incident not found.")
    return row


def get_action(db, event_id):
    event = db.get(Event, event_id)
    session = db.get(ChatSession, event.session_id) if event else None
    connection = db.get(Connection, session.connection_id) if session else None
    if not event or event.kind != "tool_call" or not connection or connection.provider not in PROVIDERS:
        raise HTTPException(404, "Action not found.")
    return event, session, connection


def latest_job(db, event):
    return db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event.id)
        .order_by((SafetyEvaluation.mode == "blocking").desc(), SafetyEvaluation.created_at.desc(), SafetyEvaluation.id.desc()).limit(1))


def classify(job, event, session):
    result, rules = job.result or {}, job.rules or {}
    if job.debug_result or job.model == "debug" or result.get("source") == "debug" or (job.diagnostics or {}).get("retry_of"):
        return None
    service = job.status in {"failed", "skipped"} or job.decision in {"error", "expired"}
    denied = job.decision == "deny" or result.get("recommendation") == "deny"
    if not service and not denied:
        return None
    try:
        action = json.loads(job.snapshot.get("action", "{}"))
        if not isinstance(action, dict): action = {}
    except (ValueError, TypeError):
        action = {}
    args = action.get("tool_input", {})
    if not isinstance(args, dict): args = {}
    raw_path = args.get("file_path", args.get("path"))
    resource = ""
    if isinstance(raw_path, str) and raw_path and not job.snapshot.get("action_truncated"):
        cwd = args.get("workdir", args.get("cwd", action.get("cwd"))) or ""
        # Lexical normalization only. Investigation must never touch the target filesystem.
        pathmod = ntpath if ntpath.splitdrive(raw_path)[0] or "\\" in raw_path or ntpath.splitdrive(str(cwd))[0] else posixpath
        resource = pathmod.normpath(pathmod.join(str(cwd), raw_path))
        if pathmod is ntpath: resource = resource.casefold()
    source = result.get("source", "judge")
    finding = sorted(str(f.get("id", "")) for f in rules.get("findings", []) if f.get("id"))
    policy = rules.get("policy", {})
    signal = policy.get("rule_ids", []) if source == "policy" else finding if source == "rules" else ["judge-denial"]
    if service:
        family = "deadline" if job.decision == "expired" else "capacity" if job.status == "skipped" else "evaluation"
        key = [session.connection_id, "service", family]
        title = {"deadline": "Requests timing out", "capacity": "Review capacity reached", "evaluation": "Evaluations failing"}[family]
        reason = "Grouped because requests on this connection had the same kind of failure within ten minutes."
    else:
        key = [session.connection_id, session.id, source, signal, event.tool_name, resource or job.input_hash]
        target = resource.replace("\\", "/").rsplit("/", 1)[-1] if resource else event.tool_name or "tool"
        title = f"{target}: {'rule prohibition' if source == 'rules' else 'judge concern' if source != 'policy' else 'repeated blocked requests'}"
        reason = "Grouped because requests came from the same session, used the same tool and finding, and targeted the same file within ten minutes." if resource else "Grouped because requests came from the same session with the same assessed action and finding within ten minutes."
    return {"signature": hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest(), "title": title[:200],
        "kind": "service" if service else "concern", "reason": reason,
        "immediate": not service and source != "policy" and result.get("recommendation") == "deny"}


def link_action(db, incident, event, job, source):
    existing = db.scalar(select(IncidentLink).where(IncidentLink.incident_id == incident.id,
        IncidentLink.event_id == event.id, IncidentLink.evaluation_id == (job.id if job else None)))
    if existing: return False
    db.add(IncidentLink(incident_id=incident.id, event_id=event.id, evaluation_id=job.id if job else None, source=source))
    incident.last_activity_at = max(incident.last_activity_at, job.created_at if job else event.occurred_at)
    incident.revision += 1
    log(db, incident, "attached", f"Added {event.tool_name or 'tool'} request (action {event.id}).", "Relay" if source == "automatic" else "local operator")
    if source == "manual" and job:
        candidate = db.get(IncidentCandidate, job.id)
        if candidate: candidate.handled = True
    return True


def correlate(db, limit=100):
    monitor = db.get(IncidentMonitor, 1)
    if not monitor:
        db.add(IncidentMonitor(id=1, enabled_at=now())); db.commit()
        return 0
    query = select(SafetyEvaluation, Event, ChatSession).join(Event, Event.id == SafetyEvaluation.event_id).join(ChatSession, ChatSession.id == Event.session_id).join(Connection)
    rows = db.execute(query.where(Connection.provider.in_(PROVIDERS), SafetyEvaluation.created_at >= monitor.enabled_at,
        SafetyEvaluation.status.in_(["completed", "failed", "skipped"]),
        ~select(IncidentCandidate.evaluation_id).where(IncidentCandidate.evaluation_id == SafetyEvaluation.id).exists())
        .order_by(SafetyEvaluation.created_at, SafetyEvaluation.id).limit(limit)).all()
    for job, event, session in rows:
        info = classify(job, event, session)
        candidate = IncidentCandidate(evaluation_id=job.id, signature=info["signature"] if info else None, occurred_at=job.created_at, handled=not bool(info))
        db.add(candidate); db.flush()
        if not info: continue
        if db.scalar(select(IncidentLink.id).where(IncidentLink.evaluation_id == job.id, IncidentLink.source == "manual").limit(1)):
            candidate.handled = True
            continue
        low = (datetime.fromisoformat(job.created_at) - timedelta(minutes=10)).isoformat()
        previous = db.scalar(select(Incident).where(Incident.signature == info["signature"])
            .order_by(Incident.created_at.desc(), Incident.id.desc()).limit(1))
        # A resolved investigation remains closed. New requests form a linked recurrence.
        eligible = select(IncidentCandidate).where(IncidentCandidate.signature == info["signature"], IncidentCandidate.handled.is_(False),
            IncidentCandidate.occurred_at >= low, IncidentCandidate.occurred_at <= job.created_at)
        if previous and previous.resolved_at:
            if job.created_at <= previous.resolved_at:
                link_action(db, previous, event, job, "automatic")
                log(db, previous, "late_evidence", "An earlier request finished assessment after resolution. The investigation remains closed.", "Relay")
                candidate.handled = True
                continue
            eligible = eligible.where(IncidentCandidate.occurred_at > previous.resolved_at)
        candidates = list(db.scalars(eligible))
        high = (datetime.fromisoformat(job.created_at) + timedelta(minutes=10)).isoformat()
        active = previous if previous and previous.status != "resolved" and low <= previous.last_activity_at <= high else None
        if not active and not info["immediate"] and len(candidates) < 3: continue
        if not active:
            active = Incident(connection_id=session.connection_id, title=info["title"], kind=info["kind"], signature=info["signature"],
                grouping_reason=info["reason"], previous_id=previous.id if previous else None,
                created_at=job.created_at, last_activity_at=job.created_at)
            db.add(active); db.flush()
            log(db, active, "created", "Opened from a recorded prohibition or judge concern." if info["immediate"] else "Opened after three matching requests within ten minutes.", "Relay")
        for c in candidates:
            evidence = db.get(SafetyEvaluation, c.evaluation_id)
            link_action(db, active, db.get(Event, evidence.event_id), evidence, "automatic")
            c.handled = True
    db.commit()
    return len(rows)


def synchronize():
    with lock, store() as db:
        # Yield quickly to gate writes under SQLite contention; retry next cycle.
        db.execute(text("PRAGMA busy_timeout=100"))
        return correlate(db)


def summary(db, row):
    connection = db.get(Connection, row.connection_id)
    count = db.scalar(select(func.count()).select_from(IncidentLink).where(IncidentLink.incident_id == row.id))
    first, last = db.execute(select(func.min(Event.occurred_at), func.max(Event.occurred_at)).join(IncidentLink, IncidentLink.event_id == Event.id).where(IncidentLink.incident_id == row.id)).one()
    return {**dump(row), "connection_name": connection.name, "action_count": count, "first_request_at": first, "last_request_at": last}


@router.get("")
def listing(status: Literal["open", "new", "investigating", "resolved", "all"] = "open", connection: str = "", q: str = "",
            offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)):
    with store() as db:
        base = select(Incident).join(Connection).where(Connection.provider.in_(PROVIDERS))
        if connection: base = base.where(Incident.connection_id == connection)
        if q.strip(): base = base.where(Incident.title.icontains(q.strip(), autoescape=True))
        counts = dict(db.execute(select(Incident.status, func.count()).where(Incident.id.in_(base.with_only_columns(Incident.id))).group_by(Incident.status)).all())
        if status == "open": base = base.where(Incident.status != "resolved")
        elif status != "all": base = base.where(Incident.status == status)
        total = db.scalar(select(func.count()).select_from(base.subquery()))
        rows = db.scalars(base.order_by(Incident.last_activity_at.desc(), Incident.id).offset(offset).limit(limit)).all()
        return {"items": [summary(db, r) for r in rows], "total": total, "counts": counts}


class CreateIncident(BaseModel):
    event_id: int
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def nonempty(cls, value):
        if not value.strip(): raise ValueError("Give the incident a title.")
        return value.strip()


@router.post("", status_code=201)
def create(body: CreateIncident):
    with lock, store() as db:
        event, _, connection = get_action(db, body.event_id)
        row = Incident(connection_id=connection.id, title=body.title, grouping_reason="Created by you from action history. Attached requests were selected manually.", last_activity_at=now())
        db.add(row); db.flush()
        log(db, row, "created", "Created from action history.")
        link_action(db, row, event, latest_job(db, event), "manual")
        db.commit()
        return summary(db, row)


@router.get("/for-action/{event_id}")
def targets(event_id: int):
    with store() as db:
        _, _, connection = get_action(db, event_id)
        rows = db.scalars(select(Incident).where(Incident.connection_id == connection.id, Incident.status != "resolved")
            .order_by(Incident.last_activity_at.desc()).limit(100)).all()
        return {"items": [summary(db, r) for r in rows], "total": len(rows), "counts": {}}


@router.get("/{id_}")
def detail(id_: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100), activity_offset: int = Query(0, ge=0)):
    from backend.safety import public
    from backend.safety import redact
    with store() as db:
        row = get_incident(db, id_)
        query = select(IncidentLink, Event, ChatSession).join(Event, Event.id == IncidentLink.event_id).join(ChatSession, ChatSession.id == Event.session_id).where(IncidentLink.incident_id == id_)
        items = []
        for link, event, session in db.execute(query.order_by(Event.occurred_at, IncidentLink.id).offset(offset).limit(limit)):
            job = db.get(SafetyEvaluation, link.evaluation_id) if link.evaluation_id else None
            items.append({"link_id": link.id, "source": link.source, "event_id": event.id, "session_id": session.id,
                "title": session.title, "tool_name": event.tool_name, "occurred_at": event.occurred_at,
                "execution_outcome": event.hook_state, "safety_state": "unassessed", "evaluation": public(job) if job else None,
                "snapshot": job.snapshot if job else {"action": redact(event.text)[:24000], "context": []}})
        activity = select(IncidentActivity).where(IncidentActivity.incident_id == id_)
        related = db.scalars(select(Incident).where(Incident.connection_id == row.connection_id, Incident.id != id_,
            or_(Incident.previous_id == id_, Incident.id == row.previous_id)).order_by(Incident.last_activity_at.desc()).limit(10)).all()
        session_ids = select(Event.session_id).join(IncidentLink, IncidentLink.event_id == Event.id).where(IncidentLink.incident_id == id_)
        lower = (datetime.fromisoformat(row.last_activity_at) - timedelta(minutes=10)).isoformat()
        upper = (datetime.fromisoformat(row.last_activity_at) + timedelta(minutes=10)).isoformat()
        nearby_ids = select(IncidentLink.incident_id).join(Event, Event.id == IncidentLink.event_id).where(
            Event.session_id.in_(session_ids), Event.occurred_at >= lower, Event.occurred_at <= upper)
        nearby = db.scalars(select(Incident).where(Incident.id.in_(nearby_ids), Incident.connection_id == row.connection_id,
            Incident.id.not_in([id_, *[r.id for r in related]])).order_by(Incident.last_activity_at.desc()).limit(5)).all()
        return {**summary(db, row), "actions": items,
            "activity": [dump(a) for a in db.scalars(activity.order_by(IncidentActivity.id.desc()).offset(activity_offset).limit(30))],
            "activity_total": db.scalar(select(func.count()).select_from(activity.subquery())),
            "related": [summary(db, r) for r in related], "nearby": [summary(db, r) for r in nearby]}


class UpdateIncident(BaseModel):
    revision: int
    status: Literal["new", "investigating", "resolved"]
    resolution: Literal["expected", "policy", "addressed", "other"] | None = None


@router.patch("/{id_}")
def update(id_: str, body: UpdateIncident):
    with lock, store() as db:
        row = get_incident(db, id_)
        if row.revision != body.revision: raise HTTPException(409, "This incident changed. Refresh it and try again.")
        if body.status == "resolved" and not body.resolution: raise HTTPException(422, "Choose a resolution.")
        if row.status == body.status and row.resolution == body.resolution: return summary(db, row)
        previous = row.status
        row.status, row.resolution = body.status, body.resolution if body.status == "resolved" else None
        row.resolved_at = now() if body.status == "resolved" else None
        row.revision += 1
        log(db, row, "status", f"Resolved: {RESOLUTIONS[body.resolution]}." if body.status == "resolved" else "Reopened for investigation." if previous == "resolved" else "Started investigating." if body.status == "investigating" else "Marked as new.")
        db.commit()
        return summary(db, row)


class Note(BaseModel):
    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def nonempty(cls, value):
        if not value.strip(): raise ValueError("Write a note first.")
        return value.strip()


@router.post("/{id_}/notes", status_code=201)
def add_note(id_: str, body: Note):
    with lock, store() as db:
        row = get_incident(db, id_)
        log(db, row, "note", body.text)
        db.commit()
        return {"saved": True}


class Attach(BaseModel):
    event_id: int


@router.post("/{id_}/actions", status_code=201)
def attach(id_: str, body: Attach):
    with lock, store() as db:
        row = get_incident(db, id_)
        if row.status == "resolved": raise HTTPException(409, "Reopen this incident before adding actions.")
        event, _, connection = get_action(db, body.event_id)
        if connection.id != row.connection_id: raise HTTPException(422, "Choose an action from the same connection.")
        link_action(db, row, event, latest_job(db, event), "manual")
        db.commit()
        return summary(db, row)


@router.delete("/{id_}/actions/{link_id}")
def detach(id_: str, link_id: int):
    with lock, store() as db:
        row = get_incident(db, id_)
        link = db.get(IncidentLink, link_id)
        if not link or link.incident_id != id_: raise HTTPException(404, "Linked action not found.")
        log(db, row, "detached", f"Removed action {link.event_id} from this incident. Its original record is unchanged.")
        db.delete(link); row.revision += 1
        db.commit()
        return {"removed": True}
