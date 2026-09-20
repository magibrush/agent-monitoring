"""Local opt-in decision simulation. Custom policies are bypassed; built-in checks remain."""
from backend.db import SafetyDebugSettings, now


def settings(db):
    row = db.get(SafetyDebugSettings, 1)
    return {"enabled": bool(row and row.enabled), "result": row.result if row else "review"}


def update(db, enabled, result):
    row = db.get(SafetyDebugSettings, 1)
    if row is None:
        row = SafetyDebugSettings(id=1)
        db.add(row)
    row.enabled, row.result, row.updated_at = enabled, result, now()
    db.commit()
    return settings(db)


def selected_result(db):
    config = settings(db)
    return config["result"] if config["enabled"] else None


def verdict(job):
    result = job.debug_result
    if result not in {"allow", "review", "deny"}:
        raise ValueError("Invalid debug result")
    reason = f"Debug mode forced {result}. No LLM was called."
    if result == "allow" and job.snapshot.get("action_truncated"):
        result = "review"
        reason = "Debug mode requested allow, but Relay's review snapshot was truncated by its size limit. This request cannot be approved; deny it and submit a smaller action. No LLM was called."
    return {"recommendation": result, "risk": "unknown", "reason": reason,
            "source": "debug", "evidence": [], "missing_context": []}
