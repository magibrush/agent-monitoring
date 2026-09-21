"""Local investigations derived from persisted assessments, outside the gate path."""
import hashlib
import json
import ntpath
import posixpath
import threading
from types import SimpleNamespace
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, func, or_, select, text

from backend.db import (ChatSession, Connection, Event, Incident, IncidentActivity,
    IncidentCandidate, IncidentLink, IncidentMonitor, SafetyEvaluation, PolicyVersion, PolicyState, PolicyChange, now)
from backend.providers import PROVIDERS

router = APIRouter(prefix="/api/safety/incidents")
lock = threading.RLock()
RESOLUTIONS = {"expected": "Expected activity", "policy": "Policy needs adjusting", "addressed": "Issue addressed", "other": "Other", "dismissed": "Dismissed"}


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


SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def severity_of(job):
    result = (job.result or {}) if job else {}
    severity = result.get("severity", result.get("risk", "medium"))
    if severity not in SEVERITY_RANK: severity = "medium"
    if result.get("recommendation") in {"review", "deny"} and SEVERITY_RANK[severity] < 2:
        severity = "high"
    return severity


def classify(job, event, session, db=None):
    result, rules = job.result or {}, job.rules or {}
    if job.debug_result or job.model == "debug" or result.get("source") == "debug" or (job.diagnostics or {}).get("retry_of"):
        return None
    service = job.status in {"failed", "skipped"} or job.decision in {"error", "expired"}
    denied = job.decision == "deny" or result.get("recommendation") == "deny"
    source = result.get("source", "judge")
    suspicious = source == "judge" and result.get("suspicious") is True
    judge_review = source == "judge" and result.get("recommendation") == "review"
    if not service and not denied and not suspicious and not judge_review:
        return None
    try:
        action = json.loads((job.snapshot or {}).get("action", "{}"))
        if not isinstance(action, dict): action = {}
    except (ValueError, TypeError):
        action = {}
    args = action.get("tool_input", {})
    if not isinstance(args, dict): args = {}
    raw_path = args.get("file_path", args.get("path"))
    resource = ""
    if isinstance(raw_path, str) and raw_path and not (job.snapshot or {}).get("action_truncated"):
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
        reason = "Opened after three requests on this connection had the same kind of failure within ten minutes. Later matching failures update this item."
    elif source == "judge" and (suspicious or judge_review or denied):
        key = [session.connection_id, session.id, "judge-concern"]
        title = "Conversation flagged for attention"
        reason = "Grouped from the same conversation across tools and judge concerns. The timeline includes the surrounding task and recorded outcomes."
    elif source == "policy":
        winner = recorded_rule(db, job) if db is not None else None
        key = [session.connection_id, "policy", winner["id"] if winner else sorted(signal)]
        title = f"Repeated requests matched {winner['name']}" if winner else "Repeated policy interruptions"
        reason = "Grouped because the same policy rule interrupted requests on this connection three times within ten minutes. Later matching requests update this item."
    else:
        key = [session.connection_id, session.id, source, signal, event.tool_name, resource or job.input_hash]
        target = resource.replace("\\", "/").rsplit("/", 1)[-1] if resource else event.tool_name or "tool"
        title = f"Repeated requests for {target}"
        reason = "Grouped because requests came from the same session, used the same tool and finding, and targeted the same file within ten minutes." if resource else "Grouped because requests came from the same session with the same assessed action and finding within ten minutes."
    return {"signature": hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest(), "title": title[:200],
        "kind": "service" if service else "concern", "reason": reason, "severity": severity_of(job),
        "suspicious": suspicious,
        "immediate": not service and (suspicious or judge_review or (source == "judge" and denied)
            or (job.mode == "shadow" and result.get("risk") == "high" and denied))}



def link_action(db, incident, event, job, source):
    existing = db.scalar(select(IncidentLink).where(IncidentLink.incident_id == incident.id,
        IncidentLink.event_id == event.id, IncidentLink.evaluation_id == (job.id if job else None)))
    if existing: return False
    db.add(IncidentLink(incident_id=incident.id, event_id=event.id, evaluation_id=job.id if job else None, source=source))
    incident.last_activity_at = max(incident.last_activity_at, job.created_at if job else event.occurred_at)
    incident.revision += 1
    evidence_severity = severity_of(job)
    if SEVERITY_RANK[evidence_severity] > SEVERITY_RANK.get(incident.severity, 0): incident.severity = evidence_severity
    db.flush()
    from backend.incident_analysis import queue_analysis
    queue_analysis(db, incident)
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
        SafetyEvaluation.status.in_(["completed", "failed", "skipped", "awaiting_review"]),
        ~select(IncidentCandidate.evaluation_id).where(IncidentCandidate.evaluation_id == SafetyEvaluation.id).exists())
        .order_by(SafetyEvaluation.created_at, SafetyEvaluation.id).limit(limit)).all()
    for job, event, session in rows:
        info = classify(job, event, session, db)
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
        active = previous if previous and previous.status != "resolved" else None
        if not active and len(candidates) < 3 and not info["immediate"]: continue
        if not active and previous and previous.resolution == "dismissed":
            active = previous
            active.status, active.resolution, active.resolved_at = "new", None, None
            active.revision += 1
            log(db, active, "resurfaced", "New suspicious activity was recorded after dismissal." if info["immediate"] else f"Shown again after {len(candidates)} new matching requests.", "Relay")
        if not active:
            active = Incident(connection_id=session.connection_id, title=info["title"], kind=info["kind"], severity=info["severity"], signature=info["signature"],
                grouping_reason=info["reason"], previous_id=previous.id if previous else None,
                created_at=job.created_at, last_activity_at=job.created_at)
            db.add(active); db.flush()
            log(db, active, "created", "A judge concern was recorded. See the verdict and gate receipt for its outcome." if info["immediate"] else "Opened after three matching requests within ten minutes.", "Relay")
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
    return {**dump(row), "connection_name": connection.name, "action_count": count, "first_request_at": first, "last_request_at": last,
            **insight(db, row)}


def recorded_rule(db, job, versions=None):
    """Recover the priority winner from the version assessed, not today's rules."""
    if not job or (job.result or {}).get("source") != "policy": return None
    policy = (job.rules or {}).get("policy", {})
    versions = versions if versions is not None else {}
    version_id = policy.get("version")
    if version_id not in versions:
        versions[version_id] = db.get(PolicyVersion, version_id) if version_id else None
    version = versions[version_id]
    if not version: return None
    matches = [r for r in version.rules if r.get("id") in policy.get("rule_ids", [])]
    return min(matches, key=lambda r: ({"deny": 0, "review": 1, "judge": 2, "allow": 3}.get(r.get("effect"), 4), r["id"])) if matches else None


def insight(db, row):
    fields = ("id", "mode", "decision", "status", "result", "rules", "review_ready_at", "human_decision", "gate", "deadline", "returned_at")
    query = select(*[getattr(SafetyEvaluation, key).label(key) for key in fields], Event.id.label("event_id"), ChatSession.title.label("session_title")).select_from(IncidentLink).join(Event, Event.id == IncidentLink.event_id).join(ChatSession, ChatSession.id == Event.session_id).outerjoin(SafetyEvaluation, SafetyEvaluation.id == IncidentLink.evaluation_id).where(IncidentLink.incident_id == row.id)
    # Exact totals use SQL; explanations inspect a bounded sample, disclosed below.
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = [(SimpleNamespace(**{key: r[key] for key in fields}) if r["id"] else None,
             SimpleNamespace(id=r["event_id"]), SimpleNamespace(title=r["session_title"]))
            for r in db.execute(query.order_by(Event.occurred_at, IncidentLink.id).limit(500)).mappings()]
    sessions = db.scalar(select(func.count(func.distinct(Event.session_id))).select_from(IncidentLink).join(Event, Event.id == IncidentLink.event_id).where(IncidentLink.incident_id == row.id))
    blocked = sum(bool(j and j.mode == "blocking" and (j.decision == "deny" or (j.gate or {}).get("decision") == "deny")) for j, _, _ in rows)
    reviewed = sum(bool(j and (j.review_ready_at or j.human_decision or j.status == "awaiting_review")) for j, _, _ in rows)
    headline = row.title
    explanation = "Saved from action history for a closer look."
    next_step, rule = "evidence", None
    first_job = next((j for j, _, _ in rows if j), None)
    versions = {}
    winner = recorded_rule(db, first_job, versions)
    winners = [recorded_rule(db, j, versions) for j, _, _ in rows]
    same_rule = winner and all(r and r["id"] == winner["id"] for r in winners)
    if row.signature and row.kind != "service":
        verb = "were blocked" if blocked == len(rows) and rows else "needed a decision" if reviewed == len(rows) and rows else "were flagged"
        headline = f"{total} matching request{'s' if total != 1 else ''} {verb}" if total <= 500 else f"{total} related requests to review"
        explanation = f"{sessions} session{'s' if sessions != 1 else ''} requested the same action or file repeatedly."
        if total == 1 and first_job and first_job.mode == "shadow":
            headline = "A concern was flagged without blocking"
            explanation = "The assessment flagged a high-risk request in shadow mode. Check the recorded outcome and context."
    flagged = [j for j, _, _ in rows if j and (j.result or {}).get("suspicious") is True]
    judge_concerns = [j for j, _, _ in rows if j and (j.result or {}).get("source", "judge") == "judge" and (j.result or {}).get("recommendation") in {"review", "deny"}]
    if flagged or judge_concerns:
        strongest = max(flagged or judge_concerns, key=lambda j: SEVERITY_RANK[severity_of(j)])
        explanation = (strongest.result or {}).get("reason") or "The judge flagged a concern in this conversation."
        headline = "Allowed by the judge, flagged" if flagged and all((j.result or {}).get("recommendation") == "allow" for j in flagged) and not judge_concerns else "The judge flagged a concern"
        if judge_concerns and not flagged:
            headline = "The judge requested review" if any((j.result or {}).get("recommendation") == "review" for j in judge_concerns) else "The judge recommended blocking"
    if same_rule:
        rule = {"id": winner["id"], "name": winner["name"], "version": first_job.rules["policy"]["version"], "recorded": winner}
        next_step = "rule"
        explanation = f"{'The sampled requests' if total > 500 else 'These requests'} matched “{winner['name']}”. Review its scope if this is expected work."
    if row.kind == "service":
        rule = None
        next_step = "diagnostics"
        headline = f"{total} requests ran into evaluation problems"
        expired = [j for j, _, _ in rows if j and j.decision == "expired"]
        short = [j for j in expired if j.review_ready_at and j.deadline and 0 <= (datetime.fromisoformat(j.deadline) - datetime.fromisoformat(j.review_ready_at)).total_seconds() < 5]
        if expired and len(expired) == len(rows):
            headline = f"{total} requests expired"
        explanation = "Check the recorded timing and worker status to see what held these requests up."
        if short and len(short) == len(rows):
            explanation = "Each sampled request reached human review with less than five seconds left."
        elif all(j and j.status == "skipped" for j, _, _ in rows) and rows:
            explanation = "These requests hit the pending-request limit. Check the queue and worker status."
    latest_activity = db.scalar(select(IncidentActivity).where(IncidentActivity.incident_id == row.id, IncidentActivity.kind == "resurfaced").order_by(IncidentActivity.id.desc()).limit(1))
    return {"headline": headline, "explanation": explanation, "next_step": next_step, "rule": rule,
        "session_count": sessions, "session_title": rows[0][2].title if sessions == 1 and rows else None,
        "sampled": len(rows), "blocked": blocked, "reviewed": reviewed, "suspicious": bool(flagged),
        "allowed_flagged": sum((j.result or {}).get("recommendation") == "allow" for j in flagged),
        "released": sum(bool(j and j.returned_at and (j.gate or {}).get("decision") == "pass") for j, _, _ in rows), "resurfaced": latest_activity.text if latest_activity else None}


def followup(db, row, rule):
    if not rule: return None
    state = db.get(PolicyState, 1)
    active = db.get(PolicyVersion, state.active_id) if state and state.active_id else None
    if not active:
        return {"message": "Custom rules are paused." if state and state.paused_id else "No custom policy is currently applied.", "changed": False}
    current = next((r for r in active.rules if r.get("id") == rule["id"]), None)
    if current == rule["recorded"]:
        return {"message": "This rule is still using the settings recorded for these requests.", "changed": False}
    applied = db.scalar(select(PolicyChange).where(PolicyChange.version_id == active.id,
        PolicyChange.action.in_(["activate", "rollback"])).order_by(PolicyChange.id.desc()).limit(1))
    if not applied: return {"message": "The applied rule differs from the recorded rule. Its application time is unavailable.", "changed": True}
    fields = ("id", "result", "rules", "diagnostics", "mode")
    query = select(*[getattr(SafetyEvaluation, k) for k in fields], Event.session_id).join(Event).join(ChatSession).where(
        ChatSession.connection_id == row.connection_id, SafetyEvaluation.created_at > applied.created_at,
        SafetyEvaluation.debug_result.is_(None), SafetyEvaluation.model != "debug",
        SafetyEvaluation.status.in_(["completed", "failed", "skipped", "awaiting_review"]),
        SafetyEvaluation.diagnostics["retry_of"].as_string().is_(None))
    records = db.execute(query.order_by(SafetyEvaluation.created_at.desc()).limit(2001)).mappings().all()
    capped = len(records) > 2000
    records = records[:2000]
    versions = {}
    triggered = []
    for record in records:
        job = SimpleNamespace(**record)
        winner = recorded_rule(db, job, versions)
        if job.mode == "blocking" and winner and winner["id"] == rule["id"] and (job.result or {}).get("recommendation") in {"review", "deny"}:
            triggered.append(record)
    if not records:
        message = "No later assessments have been recorded on this connection yet."
    elif triggered:
        sessions = len({r["session_id"] for r in triggered})
        message = f"{len(triggered)} of {'the latest ' if capped else ''}{len(records)} later requests still triggered this rule across {sessions} session{'s' if sessions != 1 else ''}."
    else:
        message = f"None of {'the latest ' if capped else ''}{len(records)} later requests on this connection triggered this rule."
    return {"changed": True, "applied_at": applied.created_at, "removed": current is None,
        "message": message, "assessed": len(records), "triggered": len(triggered), "capped": capped}


@router.get("")
def listing(status: Literal["open", "new", "investigating", "resolved", "all"] = "open", connection: str = "", q: str = "",
            offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100), severity: Literal["", "low", "medium", "high", "critical"] = ""):
    with store() as db:
        base = select(Incident).join(Connection).where(Connection.provider.in_(PROVIDERS))
        if connection: base = base.where(Incident.connection_id == connection)
        if severity: base = base.where(Incident.severity == severity)
        if q.strip(): base = base.where(Incident.title.icontains(q.strip(), autoescape=True))
        counts = dict(db.execute(select(Incident.status, func.count()).where(Incident.id.in_(base.with_only_columns(Incident.id))).group_by(Incident.status)).all())
        if status == "open": base = base.where(Incident.status != "resolved")
        elif status != "all": base = base.where(Incident.status == status)
        total = db.scalar(select(func.count()).select_from(base.subquery()))
        rows = db.scalars(base.order_by(case(SEVERITY_RANK, value=Incident.severity, else_=1).desc(), Incident.last_activity_at.desc(), Incident.id).offset(offset).limit(limit)).all()
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
        metadata = summary(db, row)
        from backend.incident_analysis import evidence_bundle, public_analysis
        return {**metadata, "timeline": evidence_bundle(db, row), "analysis": public_analysis(db, row), "followup": followup(db, row, metadata["rule"]), "actions": items,
            "activity": [dump(a) for a in db.scalars(activity.order_by(IncidentActivity.id.desc()).offset(activity_offset).limit(30))],
            "activity_total": db.scalar(select(func.count()).select_from(activity.subquery())),
            "related": [summary(db, r) for r in related], "nearby": [summary(db, r) for r in nearby]}


class UpdateIncident(BaseModel):
    revision: int
    status: Literal["new", "investigating", "resolved"]
    resolution: Literal["expected", "policy", "addressed", "other", "dismissed"] | None = None


class PreviewRequests(BaseModel):
    revision: int


@router.post("/{id_}/preview")
def preview_requests(id_: str, body: PreviewRequests):
    from backend import policies
    with policies.lock, lock, store() as db:
        row = get_incident(db, id_)
        state = db.get(PolicyState, 1)
        if not state or state.revision != body.revision:
            raise HTTPException(409, "The policy changed. Refresh before testing.")
        draft = db.get(PolicyVersion, state.draft_id) if state.draft_id else None
        if not draft: raise HTTPException(409, "Save a draft before testing these requests.")
        connection = db.get(Connection, row.connection_id)
        rows = db.execute(select(IncidentLink, SafetyEvaluation, ChatSession).join(Event, Event.id == IncidentLink.event_id)
            .join(ChatSession, ChatSession.id == Event.session_id).outerjoin(SafetyEvaluation, SafetyEvaluation.id == IncidentLink.evaluation_id)
            .where(IncidentLink.incident_id == id_).order_by(Event.occurred_at.desc(), IncidentLink.id.desc()).limit(501)).all()
        counts = {key: 0 for key in ("allow", "review", "deny", "judge", "none", "unavailable")}
        items = []
        for link, job, session in rows[:500]:
            try:
                if not job or not job.snapshot or job.snapshot.get("action_truncated"): raise ValueError()
                raw = job.snapshot["action"]
                payload = json.loads(raw)
                if not isinstance(payload, dict) or "[REDACTED" in raw: raise ValueError()
                result = policies.match(draft, payload, connection.id)
                item = {"event_id": link.event_id, "previous": (job.result or {}).get("recommendation"),
                    "proposed": result["decision"], "reason": result["reason"], "session": session.title}
            except (ValueError, KeyError, TypeError, OSError, RuntimeError):
                item = {"event_id": link.event_id, "previous": (job.result or {}).get("recommendation") if job else None,
                    "proposed": "unavailable", "reason": "The saved request is incomplete or unavailable.", "session": session.title}
            item["evaluation_id"] = job.id if job else None
            counts[item["proposed"]] += 1
            items.append(item)
        # This focused comparison doesn't mark the whole draft as simulated.
        return {"revision": state.revision, "version_id": draft.id, "sampled": len(items), "capped": len(rows) > 500, "counts": counts, "items": items}


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
        log(db, row, "status", "Dismissed. New repeated activity can bring this item back." if body.resolution == "dismissed" else f"Resolved: {RESOLUTIONS[body.resolution]}." if body.status == "resolved" else "Shown in Needs attention again." if previous == "resolved" else "Started investigating." if body.status == "investigating" else "Marked as new.")
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
