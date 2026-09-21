"""Large patch evidence must survive intake without weakening truncation guards."""
import json
from uuid import uuid4

import pytest
from sqlalchemy import select

from backend import hooks, safety, safety_debug, safety_worker
from backend.db import SafetyEvaluation
from backend.tests.test_hooks import connection, envelope
from backend.tests.test_monitor import store, transcript


@pytest.mark.parametrize("size", [36000, safety.MAX_ACTION_CHARS, safety.MAX_ACTION_CHARS + 1])
@pytest.mark.parametrize("debug_result", ["allow", "review"])
def test_large_patch_debug_and_human_approval(store, tmp_path, monkeypatch, size, debug_result):
    path = tmp_path / "rollout.jsonl"
    transcript(path, "codex_cli_rs")
    patch = "*** Begin Patch\n*** Add File: guide.md\n+"
    tail = "\n+END_OF_PATCH_EVIDENCE\n*** End Patch"
    action = {"tool_name": "apply_patch", "tool_input": {"input": patch + tail}, "cwd": None}
    overhead = len(json.dumps(action, sort_keys=True, ensure_ascii=False))
    action["tool_input"]["input"] = patch + "x" * (size - overhead) + tail
    raw = json.dumps(action, sort_keys=True, ensure_ascii=False)
    assert len(raw) == size
    with store() as db:
        safety_debug.update(db, True, debug_result)
        c = connection(db, tmp_path)
        item = envelope(path, **action)
        item["request"] = {"id": str(uuid4()), "deadline": safety.later(60)}
        hooks.ingest(db, c, item)
        db.commit()
        job = db.scalar(select(SafetyEvaluation))
        id_ = job.id
        truncated = size > safety.MAX_ACTION_CHARS
        assert job.snapshot["action_truncated"] is truncated
        assert job.snapshot["action"] == raw[:safety.MAX_ACTION_CHARS]
        if not truncated:
            assert json.loads(job.snapshot["action"]) == action
    monkeypatch.setattr(safety, "read_key", lambda: None)
    monkeypatch.setattr(safety_worker, "bounded_evaluate", lambda *_: pytest.fail("Debug called LLM"))
    assert safety_worker.run_one(store)
    with store() as db:
        job = db.get(SafetyEvaluation, id_)
        if truncated:
            assert job.decision != "pass"
            assert not safety.human_review(db, id_, "approve", job.input_hash)
            if debug_result == "allow":
                assert "size limit" in job.result["reason"]
                assert "submit a smaller action" in job.result["reason"]
        elif debug_result == "allow":
            assert job.decision == "pass"
        else:
            assert safety.human_review(db, id_, "approve", job.input_hash)
            db.refresh(job)
            assert job.decision == "pass"
