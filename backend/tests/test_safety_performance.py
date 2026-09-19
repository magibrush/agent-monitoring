import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from backend import main, safety, safety_worker, hooks, judge
from backend.db import SafetyEvaluation, SafetyAttempt, Connection
from backend.safety_metrics import timings, summary
from backend.safety_cases import CASES, job_for
from backend.safety_policy import assess
from backend.tests.test_monitor import store, transcript
from backend.tests.test_safety import add_job
from backend.tests.test_hooks import connection, envelope


def blocking(store, tmp_path, call="blocking", seconds=60):
    path = tmp_path / "rollout.jsonl"
    transcript(path, "codex_cli_rs")
    with store() as db:
        c = db.scalar(select(Connection)) or connection(db, tmp_path)
        item = envelope(path, call=call)
        item["request"] = {"id": str(uuid4()), "deadline": safety.later(seconds)}
        hooks.ingest(db, c, item); db.commit()
        return db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.request_key == item["request"]["id"])).id


def test_shadow_cannot_consume_reserved_admission_or_worker(store, tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "MAX_PENDING", 3)
    monkeypatch.setattr(safety, "BLOCKING_RESERVE", 2)
    shadow = add_job(store, tmp_path, call="one")
    skipped = add_job(store, tmp_path, call="two")
    with store() as db:
        assert db.get(SafetyEvaluation, skipped).status == "skipped"
    assert safety.claim(store, blocking_only=True) is None
    live = blocking(store, tmp_path)
    assert safety.claim(store, blocking_only=True).id == live
    assert safety.claim(store).id == shadow
    assert safety_worker.worker_lanes(2) == [True, False]
    assert safety_worker.worker_lanes(1) == [True]


def test_connection_pending_limit_and_budget_exhaustion(store, tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "MAX_BLOCKING_PER_CONNECTION", 1)
    first = blocking(store, tmp_path)
    second = blocking(store, tmp_path, "second")
    with store() as db:
        assert db.get(SafetyEvaluation, second).status == "skipped"
        assert db.get(SafetyEvaluation, second).decision == "error"
        db.get(SafetyEvaluation, first).deadline = safety.later(31)
        db.commit()
    assert safety.claim(store) is None
    with store() as db:
        assert db.get(SafetyEvaluation, first).decision == "error"


def test_deadline_lease_recovery_and_late_model_fencing(store, tmp_path):
    id_ = blocking(store, tmp_path)
    old = safety.claim(store)
    assert (datetime.fromisoformat(old.lease_until)-datetime.now(timezone.utc)).total_seconds() < 13
    with store() as db:
        db.get(SafetyEvaluation, id_).lease_until = safety.later(-1); db.commit()
    replacement = safety.claim(store)
    assert replacement.lease_token != old.lease_token
    assert not safety.finish(store, old, result={"recommendation": "allow"})
    with store() as db:
        db.get(SafetyEvaluation, id_).deadline = safety.later(31); db.commit()
    assert not safety.finish(store, replacement, result={"recommendation": "allow"})
    with store() as db:
        assert db.get(SafetyEvaluation, id_).decision == "error"


def test_retries_and_review_window_keep_original_deadline(store, tmp_path):
    id_ = blocking(store, tmp_path)
    first = safety.claim(store)
    assert safety.finish(store, first, error="temporary", retryable=True, latency_ms=500, usage={"input_tokens": 2})
    with store() as db:
        db.get(SafetyEvaluation, id_).available_at = safety.later(-1); db.commit()
    second = safety.claim(store)
    assert safety.finish(store, second, result={"recommendation": "review"}, latency_ms=700, usage={"input_tokens": 3})
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        attempts = list(db.scalars(select(SafetyAttempt).where(SafetyAttempt.evaluation_id == id_)))
        assert job.deadline == first.deadline
        assert job.status == "awaiting_review"
        assert timings(job, attempts)["model_ms"] == 1200
        assert timings(job, attempts)["review_remaining_ms"] >= 30000
        assert sum(a.usage["input_tokens"] for a in attempts) == 5


def hanging_judge(channel, job, key):
    time.sleep(20)


def successful_judge(channel, job, key):
    channel.send(("ok", {"recommendation": "allow", "job_id": job.id}, {"input_tokens": 3}))
    channel.close()


def test_spawned_judge_receives_detached_job_and_returns_result(store, tmp_path):
    blocking(store, tmp_path)
    job = safety.claim(store)
    result, usage = safety_worker.bounded_evaluate(job, "synthetic", target=successful_judge)
    assert result["job_id"] == job.id and usage["input_tokens"] == 3


def test_wall_clock_supervisor_terminates_hung_judge(monkeypatch):
    monkeypatch.setattr(safety_worker, "attempt_timeout", lambda job: .2)
    started = time.monotonic()
    with pytest.raises(judge.JudgeError, match="wall-clock"):
        safety_worker.bounded_evaluate(SimpleNamespace(), "synthetic", target=hanging_judge)
    assert time.monotonic() - started < 5


def test_hook_collector_does_not_wait_for_transcript_lock(store):
    done = threading.Event()
    with main.lock:
        thread = threading.Thread(target=lambda: (main.synchronize_hooks(), done.set()))
        thread.start()
        assert done.wait(2)
    thread.join(2)


def test_operational_metrics_include_failures_and_unknown_receipts(store, tmp_path):
    id_ = blocking(store, tmp_path)
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        job.decision = "error"
        job.returned_at = (datetime.fromisoformat(job.created_at) + timedelta(seconds=3)).isoformat()
        db.commit()
        stats = summary(db)
        assert stats["automatic_pause"]["p95_ms"] == 3000
        assert stats["failed"] == 1
        job.returned_at = None; db.commit()
        assert summary(db)["automatic_pause"]["samples"] == 0
        assert summary(db)["missing_receipts"] == 1


def test_synthetic_corpus_is_complete_and_has_no_implicit_rule_allow():
    assert {case[1] for case in CASES} == {"allow", "review", "deny"}
    assert len({case[0] for case in CASES}) == len(CASES)
    for case in CASES:
        job = job_for(case)
        _, expected, tool, args = case
        result = assess({"tool_name": tool, "tool_input": args, "cwd": "D:/fictional-project"})
        assert result["decision"] != "allow"
        if result["decision"] == "deny":
            assert expected == "deny"
        assert "recorded_user_message" in job.snapshot["user_intent"][0]["source"]


def test_transcript_batches_commit_checkpoints_and_replay_without_duplicates(store, tmp_path):
    from backend.connectors import sync_codex
    from backend.db import Event, Checkpoint
    from sqlalchemy import func
    path = tmp_path / "rollout.jsonl"
    transcript(path, "codex_cli_rs")
    with store() as db:
        c = connection(db, tmp_path); db.commit()
        sync_codex(db, c, batch_size=2)
        with store() as other:
            assert other.scalar(select(func.count()).select_from(Event)) == 3
            assert other.scalar(select(Checkpoint.offset)) == path.stat().st_size
        assert sync_codex(db, c, batch_size=2) == 0
        assert db.scalar(select(func.count()).select_from(Event)) == 3
