"""One deadline budget shared by scheduler and evaluator (seconds)."""
from datetime import datetime, timezone

HUMAN_RESERVE = 30
DELIVERY_MARGIN = 2
ATTEMPT_SECONDS = 10
MIN_ATTEMPT_SECONDS = 2
LEASE_MARGIN = 2


def remaining(job):
    if getattr(job, "mode", "shadow") != "blocking":
        return 25.0
    return (datetime.fromisoformat(job.deadline) - datetime.now(timezone.utc)).total_seconds() - HUMAN_RESERVE - DELIVERY_MARGIN


def attempt_timeout(job):
    return max(0, min(ATTEMPT_SECONDS if getattr(job, "mode", "shadow") == "blocking" else 25, remaining(job)))
