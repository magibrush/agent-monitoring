from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend import main, safety, hooks, judge
from backend.db import SafetyEvaluation
from backend.tests.test_monitor import store, transcript
from backend.tests.test_hooks import connection, envelope


def waiting(store, tmp_path):
    path = tmp_path / "rollout.jsonl"
    transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path)
        item = envelope(path)
        item["request"] = {"id": str(uuid4()), "deadline": safety.later(50)}
        hooks.ingest(db, c, item)
        db.commit()
    job = safety.claim(store)
    assert safety.finish(store, job, result={"recommendation": "review", "risk": "medium", "reason": "Synthetic uncertainty", "evidence": [], "missing_context": [], "source": "judge"})
    return job


@pytest.mark.parametrize("condition", ["expired", "returned", "wrong_hash", "shadow", "hard_deny", "truncated"])
def test_approval_cannot_release_ineligible_requests(store, tmp_path, condition):
    job = waiting(store, tmp_path)
    with store() as db:
        saved = db.get(SafetyEvaluation, job.id)
        if condition == "expired": saved.deadline = safety.later(-1)
        if condition == "returned": saved.returned_at = safety.now()
        if condition == "shadow": saved.mode = "shadow"
        if condition == "hard_deny": saved.rules = {"decision": "deny"}
        if condition == "truncated": saved.snapshot = {**saved.snapshot, "action_truncated": True}
        db.commit()
    client = TestClient(main.app, base_url="http://localhost")
    response = client.post(f"/api/safety/evaluations/{job.id}/review", json={"decision": "approve", "input_hash": "0" * 64 if condition == "wrong_hash" else job.input_hash})
    assert response.status_code == 409
    with store() as db:
        saved = db.get(SafetyEvaluation, job.id)
        assert saved.decision != "pass" and saved.human_decision is None
        if condition == "expired": assert saved.decision == "expired"


def test_concurrent_human_decisions_have_one_winner(store, tmp_path):
    job = waiting(store, tmp_path)
    def decide(choice):
        with store() as db:
            return choice, safety.human_review(db, job.id, choice, job.input_hash)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(decide, ["approve", "deny"]))
    winners = [choice for choice, success in results if success]
    assert len(winners) == 1
    with store() as db:
        saved = db.get(SafetyEvaluation, job.id)
        assert saved.human_decision == winners[0] and saved.reviewed_at
        assert saved.result["recommendation"] == "review"


def test_review_has_separate_metrics_and_expiry_state(store, tmp_path):
    job = waiting(store, tmp_path)
    client = TestClient(main.app, base_url="http://localhost")
    assert client.get("/api/metrics").json()["safety"]["awaiting_review"] == 1
    assert client.get("/api/safety/actions?safety_state=awaiting_review").json()["total"] == 1
    with store() as db:
        db.get(SafetyEvaluation, job.id).deadline = safety.later(-1)
        safety.expire(db)
        db.commit()
    assert client.get("/api/safety/actions?safety_state=awaiting_review").json()["total"] == 0
    assert client.get("/api/metrics").json()["safety"]["error"] == 1
