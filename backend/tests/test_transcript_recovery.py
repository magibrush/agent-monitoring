import json

import pytest
from sqlalchemy import select, func

from backend import hooks, main, connectors
from backend.connectors import sync_codex
from backend.db import Connection, Event, Checkpoint, HookObservation, SafetyEvaluation
from backend.tests.test_monitor import store, transcript, record
from backend.tests.test_hooks import envelope


def seed(store, tmp_path, legacy=True):
    path = tmp_path / "rollout.jsonl"
    transcript(path)
    with store() as db:
        connection = Connection(name="Desktop", provider="codex", path=str(tmp_path))
        db.add(connection); db.flush()
        assert sync_codex(db, connection) == 3
        hooks.ingest(db, connection, envelope(path))
        if legacy:
            # Simulate an existing pre-upgrade database, including linked audits.
            positions = {}
            with path.open("rb") as stream:
                while line := stream.readline():
                    positions[json.dumps(json.loads(line), sort_keys=True)] = stream.tell() - len(line)
            for event in db.scalars(select(Event)):
                event.external_id = f"byte:{positions[json.dumps(event.payload, sort_keys=True)]}"
            checkpoint = db.scalar(select(Checkpoint))
            checkpoint.record_counts = None
            checkpoint.tail_hash = None
        db.commit()
        return path, connection.id, [e.id for e in db.scalars(select(Event).order_by(Event.id))]


def rewrite(path, inserted=False):
    records = [json.loads(line) for line in path.read_text().splitlines()]
    records[0]["payload"]["cli_version"] = "new-version"
    if inserted:
        records.insert(1, json.loads(record("response_item", {"type": "message", "role": "assistant", "content": "New record inserted by rewrite"})))
    for n, item in enumerate(records):
        item["ordinal"] = n
        item["metadata"] = {"rewritten": True}
    path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records), encoding="utf-8")


@pytest.mark.parametrize("inserted", [False, True])
def test_rewrite_preserves_ids_hooks_evaluations_and_counts(store, tmp_path, inserted):
    path, cid, ids = seed(store, tmp_path)
    rewrite(path, inserted)
    with store() as db:
        c = db.get(Connection, cid)
        assert sync_codex(db, c) == int(inserted)
        db.commit()
        assert all(db.get(Event, id_) for id_ in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == 3 + int(inserted)
        assert db.scalar(select(func.count()).select_from(HookObservation)) == 1
        assert db.scalar(select(func.count()).select_from(SafetyEvaluation)) == 1
        assert db.scalar(select(Checkpoint.offset)) == path.stat().st_size
        assert sync_codex(db, c) == 0
        # A later appended record and a second rewrite must also be replay-safe.
        with path.open("a", encoding="utf-8") as stream:
            stream.write(record("response_item", {"type": "message", "role": "assistant", "content": "Later append"}))
        assert sync_codex(db, c) == 1
        db.commit()
        rewrite(path)
        assert sync_codex(db, c) == 0


@pytest.mark.parametrize("change,added", [("truncate", 0), ("edit", 1), ("identity", 3), ("source", 0), ("reorder", 0)])
def test_rewrites_automatically_preserve_existing_data(store, tmp_path, change, added):
    path, cid, ids = seed(store, tmp_path)
    original = path.read_bytes()
    records = [json.loads(line) for line in original.splitlines()]
    records[0]["payload"]["cli_version"] = "changed"
    if change == "truncate":
        records = records[:-1]
    elif change == "edit":
        records[-1]["payload"]["output"] = "Changed imported result"
    elif change == "identity":
        records[0]["payload"]["id"] = "different-session"
    elif change == "reorder":
        records[1], records[-1] = records[-1], records[1]
    else:
        records[0]["payload"]["originator"] = "codex_cli_rs"
    path.write_text("".join(json.dumps(r) + "\n" for r in records))
    with store() as db:
        assert sync_codex(db, db.get(Connection, cid)) == added
        db.commit()
        assert all(db.get(Event, i) for i in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == 3 + added
        assert sync_codex(db, db.get(Connection, cid)) == 0
        assert db.get(Connection, cid).error is None


def test_recovery_rolls_back_if_later_record_is_invalid(store, tmp_path):
    path, cid, _ = seed(store, tmp_path)
    rewrite(path)
    with path.open("a") as stream:
        stream.write("not json\n")
    with store() as db:
        before = [(e.id, e.external_id) for e in db.scalars(select(Event).order_by(Event.id))]
        with pytest.raises(ValueError, match="Invalid JSON"):
            sync_codex(db, db.get(Connection, cid))
        db.rollback()
        assert [(e.id, e.external_id) for e in db.scalars(select(Event).order_by(Event.id))] == before


def test_unverifiable_file_does_not_stop_other_sessions(store, tmp_path):
    path, cid, ids = seed(store, tmp_path)
    path.write_text(record("session_meta", {"id": "session-1", "originator": "Codex Desktop"}))
    other = tmp_path / "other.jsonl"
    transcript(other)
    other.write_text(other.read_text().replace('"session-1"', '"other-session"'))
    main.synchronize(cid)
    with store() as db:
        c = db.get(Connection, cid)
        assert c.status == "watching" and c.error is None
        assert c.last_sync and all(db.get(Event, i) for i in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == 6
    main.synchronize(cid)
    with store() as db:
        assert db.scalar(select(func.count()).select_from(Event)) == 6


def test_truncation_then_new_append_is_still_collected(store, tmp_path):
    path, cid, ids = seed(store, tmp_path)
    path.write_text(record("session_meta", {"id": "session-1", "originator": "Codex Desktop"}))
    main.synchronize(cid)
    with path.open("a") as stream:
        stream.write(record("response_item", {"type": "message", "role": "assistant", "content": "After truncation"}))
    main.synchronize(cid)
    with store() as db:
        assert db.get(Connection, cid).error is None
        assert all(db.get(Event, i) for i in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == 4
        assert sync_codex(db, db.get(Connection, cid)) == 0


def test_identical_repeated_records_survive_restart_and_replay(store, tmp_path):
    path, cid, ids = seed(store, tmp_path, legacy=False)
    duplicate = record("response_item", {"type": "message", "role": "assistant", "content": "Repeated"})
    with path.open("a") as stream:
        stream.write(duplicate * 2)
    main.synchronize(cid)
    rewrite(path)
    main.synchronize(cid)
    with store() as db:
        assert db.scalar(select(func.count()).select_from(Event)) == 5
    with path.open("a") as stream:
        stream.write(duplicate)
    main.synchronize(cid)
    with store() as db:
        assert db.scalar(select(func.count()).select_from(Event)) == 6


def test_same_length_same_header_edit_is_detected_by_tail(store, tmp_path):
    path, cid, _ = seed(store, tmp_path, legacy=False)
    original = path.read_bytes()
    path.write_bytes(original.replace(b'workspace', b'new-space'))
    assert path.stat().st_size == len(original)
    main.synchronize(cid)
    with store() as db:
        assert db.get(Connection, cid).error is None
        assert db.scalar(select(func.count()).select_from(Event)) == 4


def test_replay_occurrence_counts_persist_between_bounded_batches(store, tmp_path, monkeypatch):
    path, cid, ids = seed(store, tmp_path)
    duplicate = record("response_item", {"type": "message", "role": "assistant", "content": "Batch duplicate"})
    with path.open("a") as stream:
        stream.write(duplicate * 3)
    rewrite(path)
    original = connectors.complete_records
    monkeypatch.setattr(connectors, "complete_records", lambda stream, path, offset: original(stream, path, offset, limit=2))
    for _ in range(8):
        main.synchronize(cid)
    with store() as db:
        assert all(db.get(Event, i) for i in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == 6
        assert db.scalar(select(Checkpoint.offset)) == path.stat().st_size
        assert sync_codex(db, db.get(Connection, cid)) == 0


def test_claude_rewrite_replays_without_warning_or_loss(store, tmp_path):
    from backend.tests.test_claude_code import fixture
    from backend.claude_code import sync_claude
    path = fixture(tmp_path)
    with store() as db:
        c = Connection(name="Claude", provider="claude_code", path=str(tmp_path))
        db.add(c); db.flush()
        sync_claude(db, c); db.commit(); cid = c.id
        ids = list(db.scalars(select(Event.id)))
    lines = path.read_text().splitlines()
    # Rewrite the envelope and shorten history, then append a fresh message.
    path.write_text("\n".join(lines[:2]) + "\n")
    main.synchronize(cid)
    data = json.loads(lines[1])
    data.update(uuid="new-after-rewrite", type="user", message={"role": "user", "content": "Continue after rewrite"})
    with path.open("a") as stream:
        stream.write(json.dumps(data) + "\n")
    main.synchronize(cid)
    with store() as db:
        assert db.get(Connection, cid).error is None
        assert all(db.get(Event, i) for i in ids)
        assert db.scalar(select(func.count()).select_from(Event)) == len(ids) + 1
        assert sync_claude(db, db.get(Connection, cid)) == 0
