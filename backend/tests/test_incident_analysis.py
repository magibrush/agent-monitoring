import json

import pytest
from sqlalchemy import select

from backend import incident_analysis as analysis
from backend.db import Connection, Event, Incident, IncidentAnalysis, IncidentLink, SafetyEvaluation, now
from backend.tests.test_monitor import store
from backend.tests.test_incidents import seed, job


def prepared(store):
    seed(store)
    evaluation_id, event_id = job(store, source="judge", decision="allow")
    with store() as db:
        db.get(Connection, "one").hooks_enabled = True
        incident = Incident(connection_id="one", title="Suspicious read", grouping_reason="Judge concern", revision=1)
        db.add(incident); db.flush()
        db.add(IncidentLink(incident_id=incident.id, event_id=event_id, evaluation_id=evaluation_id))
        db.flush()
        analysis.queue_analysis(db, incident)
        db.flush()
        db.get(IncidentAnalysis, incident.id).available_at = "2000-01-01"
        db.commit()
        return incident.id, event_id


def valid(event_id):
    return {"summary": "A configuration read was permitted, but it needs a closer look.",
            "findings": [{"text": "The recorded assessment permitted the read.", "evidence_ids": [event_id]}],
            "recommendations": [{"text": "Check whether the task needed this configuration.", "evidence_ids": [event_id]}]}


def test_no_key_does_not_consume_attempts(store, monkeypatch):
    id_, _ = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: None)
    assert analysis.run_one(store, lambda *_: pytest.fail("Unexpected network")) is False
    with store() as db:
        assert db.get(IncidentAnalysis, id_).attempts == 0
        assert analysis.public_analysis(db, db.get(Incident, id_))["status"] == "needs_key"


def test_result_citations_and_no_open_transaction_during_evaluation(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    def evaluator(job, key):
        # A separate writer can commit while the evaluator is running.
        with store() as db:
            db.get(Connection, "one").name = "Changed during analysis"
            db.commit()
        return valid(event_id), {"input_tokens": 5}
    assert analysis.run_one(store, evaluator)
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        assert row.status == "ready" and row.analyzed_revision == 1
        assert row.evidence["events"][0]["assessment"]["recommendation"] == "allow"
        assert row.result["findings"][0]["evidence_ids"] == [event_id]


def test_stale_and_deleted_results_are_discarded(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    def supersede(job, key):
        with store() as db:
            incident = db.get(Incident, id_)
            incident.revision += 1
            analysis.queue_analysis(db, incident)
            db.commit()
        return valid(event_id), {}
    assert analysis.run_one(store, supersede)
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        assert row.result is None and row.requested_revision == 2 and row.attempts == 0
        row.available_at = "2000-01-01"; db.commit()
    def remove(job, key):
        with store() as db:
            db.delete(db.get(Incident, id_)); db.commit()
        return valid(event_id), {}
    assert analysis.run_one(store, remove)
    with store() as db:
        assert db.get(IncidentAnalysis, id_) is None


def test_invalid_citations_fail_with_bounded_retries_and_safe_errors(store, monkeypatch):
    id_, _ = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    for attempt in (1, 2):
        assert analysis.run_one(store, lambda *_: (valid(999999), {}))
        with store() as db:
            row = db.get(IncidentAnalysis, id_)
            assert row.attempts == attempt and row.result is None
            assert "999999" not in row.error
            row.available_at = "2000-01-01"; db.commit()
    assert not analysis.run_one(store, lambda *_: pytest.fail("Third attempt"))


def test_evidence_preserves_sessions_redacts_secrets_and_separates_gate(store):
    id_, event_id = prepared(store)
    with store() as db:
        db.add(Event(session_id="session", external_id="intent", role="user", kind="message",
            text="Inspect configuration. password=private", occurred_at="2000-01-01", payload={}))
        db.add(Event(session_id="other-session", external_id="unrelated", role="user", kind="message",
            text="UNRELATED INTENT", occurred_at="2000-01-01", payload={}))
        evaluation = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event_id))
        evaluation.human_decision = "deny"
        evaluation.snapshot = {"action": "Read config token=private sk-ant-abcdef", "context": []}
        db.flush()
        bundle = analysis.evidence_bundle(db, db.get(Incident, id_))
        encoded = json.dumps(bundle)
        assert "private" not in encoded and "sk-ant-abcdef" not in encoded
        assert "UNRELATED INTENT" not in encoded
        assert any(e["role"] == "user" for e in bundle["events"])
        action = next(e for e in bundle["events"] if e["event_id"] == event_id)
        assert action["assessment"]["recommendation"] == "allow"
        assert action["gate"]["human_decision"] == "deny"
        assert len(encoded) <= analysis.MAX_CHARS and len(bundle["events"]) <= analysis.MAX_EVENTS


def test_new_evidence_retains_previous_result_as_stale_and_disabled_source_skips(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    analysis.run_one(store, lambda *_: (valid(event_id), {}))
    with store() as db:
        incident = db.get(Incident, id_)
        incident.revision += 1
        analysis.queue_analysis(db, incident)
        db.flush()
        public = analysis.public_analysis(db, incident)
        assert public["stale"] and public["result"]
        row = db.get(IncidentAnalysis, id_)
        row.available_at = "2000-01-01"
        db.get(Connection, "one").hooks_enabled = False
        db.commit()
    analysis.run_one(store, lambda *_: pytest.fail("Disabled source must not send evidence"))
    with store() as db:
        assert db.get(IncidentAnalysis, id_).status == "unavailable"


def test_receipt_change_during_analysis_discards_result(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    def evaluator(job, key):
        with store() as db:
            evaluation = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event_id))
            evaluation.gate = {"decision": "allow"}
            evaluation.returned_at = now()
            db.commit()
        return valid(event_id), {}
    assert analysis.run_one(store, evaluator)
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        assert row.result is None and row.status == "pending"


def test_continuous_evidence_does_not_postpone_analysis_forever(store):
    id_, _ = prepared(store)
    with store() as db:
        incident = db.get(Incident, id_)
        incident.revision += 1
        analysis.queue_analysis(db, incident)
        assert db.get(IncidentAnalysis, id_).available_at == "2000-01-01"


def test_abandoned_final_lease_settles_as_failed(store, monkeypatch):
    id_, _ = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        row.status = "running"
        row.attempts = 2
        row.lease_token = "dead-worker"
        row.lease_until = "2000-01-01"
        db.commit()
    assert not analysis.run_one(store, lambda *_: pytest.fail("Third attempt"))
    with store() as db:
        assert db.get(IncidentAnalysis, id_).status == "failed"


def test_published_result_is_marked_stale_when_late_transcript_arrives(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    analysis.run_one(store, lambda *_: (valid(event_id), {}))
    with store() as db:
        db.add(Event(session_id="session", external_id="late", role="tool", kind="tool_result",
            text="Read succeeded", occurred_at=now(), payload={}))
        db.flush()
        assert analysis.public_analysis(db, db.get(Incident, id_))["stale"]


def test_idle_worker_refreshes_late_receipt_without_new_link(store, monkeypatch):
    id_, event_id = prepared(store)
    monkeypatch.setattr(analysis.safety, "read_key", lambda: "sk-ant-test")
    assert analysis.run_one(store, lambda *_: (valid(event_id), {}))
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        row.available_at = "2000-01-01"
        row.analyzed_at = "2000-01-01T00:00:00+00:00"
        evaluation = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event_id))
        evaluation.gate = {"decision": "deny"}
        evaluation.returned_at = now()
        db.commit()
    assert analysis.run_one(store, lambda *_: pytest.fail("Refresh only enqueues"))
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        assert row.status == "pending" and row.attempts == 0
        assert row.requested_revision == row.analyzed_revision == 1
        assert row.result and analysis.public_analysis(db, db.get(Incident, id_))["stale"]
    assert analysis.run_one(store, lambda *_: (valid(event_id), {}))
    with store() as db:
        row = db.get(IncidentAnalysis, id_)
        assert row.status == "ready"
        assert row.evidence["events"][0]["gate"]["receipt_decision"] == "deny"
        assert not analysis.public_analysis(db, db.get(Incident, id_))["stale"]
    assert not analysis.run_one(store, lambda *_: pytest.fail("Cooldown"))


def test_character_budget_prioritizes_flagged_action_and_preserves_input_truncation(store, monkeypatch):
    id_, event_id = prepared(store)
    with store() as db:
        evaluation = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.event_id == event_id))
        evaluation.snapshot = {"action": "short but incomplete", "action_truncated": True}
        for index in range(4):
            db.add(Event(session_id="session", external_id=f"large-context-{index}", role="user", kind="message",
                text="Long context " * 1000, occurred_at=f"2000-01-0{index + 1}", payload={}))
        db.flush()
        # Simulate budget pressure: retained context must never displace the concern.
        monkeypatch.setattr(analysis, "MAX_CHARS", 2800)
        bundle = analysis.evidence_bundle(db, db.get(Incident, id_))
        action = next(item for item in bundle["events"] if item["event_id"] == event_id)
        assert action["flagged"] and action["truncated"]
        assert len(json.dumps(bundle, ensure_ascii=False)) <= 2800
        assert bundle["truncated"]
        assert bundle["events"] == sorted(bundle["events"], key=lambda item: (item["occurred_at"], item["event_id"]))


def test_eligible_saved_incident_without_analysis_has_accurate_explanation(store):
    id_, _ = prepared(store)
    with store() as db:
        db.delete(db.get(IncidentAnalysis, id_)); db.flush()
        public = analysis.public_analysis(db, db.get(Incident, id_))
        assert "not been generated" in public["error"]
