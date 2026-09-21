import sqlite3

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.orm import sessionmaker

from backend import main, incidents
from backend.db import Base, Checkpoint, Connection, Event, make_engine
from backend.tests.test_monitor import transcript


def test_real_sqlite_lock_retries_without_duplicate_records(tmp_path, monkeypatch):
    database = tmp_path / "sync.db"
    engine = make_engine("sqlite:///" + database.as_posix())
    @event.listens_for(engine, "checkout")
    def short_timeout(db, _record, _proxy):
        db.execute("PRAGMA busy_timeout=1")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, "SessionLocal", factory)
    transcript(tmp_path / "rollout.jsonl")
    with factory() as db:
        connection = Connection(name="Source", provider="codex", path=str(tmp_path), error="Old error")
        db.add(connection)
        db.commit()
        connection_id = connection.id
    writer = sqlite3.connect(database)
    writer.execute("BEGIN IMMEDIATE")
    retries = []
    def release_writer(delay):
        retries.append(delay)
        writer.rollback()
    monkeypatch.setattr(main.time, "sleep", release_writer)
    try:
        main.synchronize(connection_id)
        main.synchronize(connection_id)
        assert retries == [0.1]
        with factory() as db:
            connection = db.get(Connection, connection_id)
            assert connection.status == "watching"
            assert connection.error is None
            assert connection.last_sync
            assert db.scalar(select(func.count()).select_from(Event)) == 3
            assert db.scalar(select(Checkpoint.offset)) == (tmp_path / "rollout.jsonl").stat().st_size
    finally:
        writer.close()
        engine.dispose()


@pytest.mark.parametrize("fails", [False, True])
def test_incident_timeout_does_not_leak_to_next_database_user(tmp_path, monkeypatch, fails):
    engine = make_engine("sqlite:///" + (tmp_path / "pool.db").as_posix())
    factory = sessionmaker(engine)
    monkeypatch.setattr(main, "SessionLocal", factory)
    def correlate(db):
        assert db.scalar(text("PRAGMA busy_timeout")) == 100
        if fails:
            raise RuntimeError("Simulated collector failure")
        db.commit()
        return 0
    monkeypatch.setattr(incidents, "correlate", correlate)
    try:
        if fails:
            with pytest.raises(RuntimeError):
                incidents.synchronize()
        else:
            incidents.synchronize()
        with factory() as db:
            assert db.scalar(text("PRAGMA busy_timeout")) == 30000
    finally:
        engine.dispose()


def test_non_lock_errors_are_not_retried_and_log_location(tmp_path, monkeypatch, caplog):
    engine = make_engine("sqlite:///" + (tmp_path / "sync.db").as_posix())
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, "SessionLocal", factory)
    with factory() as db:
        connection = Connection(name="Source", provider="codex", path=str(tmp_path))
        db.add(connection)
        db.commit()
        connection_id = connection.id
    calls = []
    def broken_sync(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("private transcript text")
    monkeypatch.setattr(main, "sync_connection", broken_sync)
    try:
        main.synchronize(connection_id)
        assert calls == [1]
        with factory() as db:
            assert db.get(Connection, connection_id).error == "Sync failed (RuntimeError). See backend logs."
        assert "broken_sync" in caplog.text
        # Traceback source lines can contain literals; the exception value and
        # SQL parameters must not be formatted into the diagnostic.
        assert "RuntimeError: private transcript text" not in caplog.text
    finally:
        engine.dispose()
