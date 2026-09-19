import pytest
from fastapi.testclient import TestClient

from backend import main, safety, safety_debug, safety_worker
from backend.db import SafetyEvaluation
from backend.safety_metrics import summary
from backend.tests.test_monitor import store
from backend.tests.test_safety_performance import blocking


def configure(store, enabled=True, result="review"):
    with store() as db:
        return safety_debug.update(db, enabled, result)


def test_default_and_api_validation(store):
    with store() as db:
        assert safety_debug.settings(db) == {"enabled": False, "result": "review"}
    client = TestClient(main.app, base_url="http://127.0.0.1")
    assert client.put("/api/safety/debug", json={"enabled": True, "result": "review"}).status_code == 200
    with store() as db:
        assert safety_debug.settings(db)["enabled"] is True
    for body in ({"enabled": "yes"}, {"enabled": True, "result": "pass"}):
        assert client.put("/api/safety/debug", json=body).status_code == 422
    assert client.put("/api/safety/debug", json={"enabled": False}, headers={"Origin": "https://evil.example"}).status_code == 403


@pytest.mark.parametrize("result,decision", [("allow", "pass"), ("deny", "deny"), ("review", None)])
def test_forced_result_without_key_or_llm(store, tmp_path, monkeypatch, result, decision):
    configure(store, result=result)
    id_ = blocking(store, tmp_path)
    monkeypatch.setattr(safety, "read_key", lambda: None)
    monkeypatch.setattr(safety_worker, "bounded_evaluate", lambda *_: pytest.fail("Debug called Anthropic"))
    assert safety_worker.run_one(store)
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        assert job.result["source"] == "debug"
        assert job.result["recommendation"] == result
        assert job.decision == decision
        assert job.model == "debug"
        metrics = summary(db)
        assert metrics["requests"] == 0 and metrics["debug_requests"] == 1
        if result == "review":
            assert job.status == "awaiting_review"
            assert not safety.human_review(db, id_, "approve", "wrong-hash")
            assert safety.human_review(db, id_, "approve", job.input_hash)
            db.refresh(job)
            assert job.decision == "pass"


def test_settings_frozen_per_job_and_disable_restores_judge(store, tmp_path, monkeypatch):
    original = blocking(store, tmp_path, "original")
    configure(store)
    debug = blocking(store, tmp_path, "debug")
    configure(store, False)
    normal = blocking(store, tmp_path, "normal")
    monkeypatch.setattr(safety, "read_key", lambda: None)
    assert safety_worker.run_one(store)
    assert not safety_worker.run_one(store)
    with store() as db:
        assert db.get(SafetyEvaluation, debug).status == "awaiting_review"
        for id_ in (original, normal):
            job = db.get(SafetyEvaluation, id_)
            assert job.debug_result is None and job.attempts == 0
    monkeypatch.setattr(safety, "read_key", lambda: "synthetic")
    assert safety_worker.run_one(store, evaluator=lambda *_: ({"recommendation": "allow", "source": "judge"}, {}))
    with store() as db:
        assert db.get(SafetyEvaluation, original).result["source"] == "judge"


@pytest.mark.parametrize("restriction", ["rules", "truncated", "expired"])
def test_debug_cannot_bypass_safeguards(store, tmp_path, monkeypatch, restriction):
    configure(store, result="allow")
    id_ = blocking(store, tmp_path)
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        if restriction == "rules":
            job.rules = {"decision": "deny"}
        elif restriction == "truncated":
            job.snapshot = {**job.snapshot, "action_truncated": True}
        else:
            job.deadline = safety.later(-1)
        db.commit()
    monkeypatch.setattr(safety, "read_key", lambda: None)
    safety_worker.run_one(store)
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        assert job.decision != "pass"
        assert not safety.human_review(db, id_, "approve", job.input_hash)
        if restriction == "truncated":
            assert job.result["recommendation"] == "review"


@pytest.mark.parametrize("effect", ["allow", "review", "deny", "judge"])
def test_debug_allow_precedes_custom_policies_and_disable_restores_them(store, tmp_path, monkeypatch, effect):
    from backend.tests.test_policies import setup, save, activate, read_job
    client = TestClient(main.app, base_url="http://localhost")
    rule = setup(store, tmp_path, effect=effect)
    rule = {"schema_version": 2, "id": rule["id"], "name": rule["name"], "activity": "read", "effect": effect, "connection_ids": [rule["connection_id"]], "roots": [rule["root"]], "extensions": [".md"]}
    activate(client, save(client, rule))
    configure(store, result="allow")
    job = read_job(store, tmp_path, "debug-policy")
    assert job.debug_result == "allow" and job.status == "queued"
    monkeypatch.setattr(safety, "read_key", lambda: None)
    monkeypatch.setattr(safety_worker, "bounded_evaluate", lambda *_: pytest.fail("Debug called Anthropic"))
    assert safety_worker.run_one(store)
    with store() as db:
        result = db.get(SafetyEvaluation, job.id)
        assert result.decision == "pass" and result.result["source"] == "debug"
    configure(store, enabled=False)
    normal = read_job(store, tmp_path, "normal-policy")
    assert normal.debug_result is None
    assert normal.status == {"allow": "completed", "deny": "completed", "review": "awaiting_review", "judge": "queued"}[effect]
