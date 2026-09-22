import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from backend import main, connectors
from backend.collection_control import collection
from backend.db import ChatSession, Checkpoint, Connection, Event
from backend.tests.test_monitor import store, transcript
from backend.tests.test_claude_code import fixture


def add_connection(store, root, provider="codex"):
    with store() as db:
        c = Connection(name="Source", provider=provider, path=str(root))
        db.add(c)
        db.commit()
        return c.id


def test_background_cycle_imports_connections_concurrently(store, tmp_path, monkeypatch):
    for _ in range(2):
        add_connection(store, tmp_path)
    rendezvous = threading.Barrier(2)
    def import_together(db, c, **kwargs):
        rendezvous.wait(timeout=3)
    monkeypatch.setattr(main, "sync_connection", import_together)
    main.synchronize()
    with store() as db:
        assert all(c.status == "watching" for c in db.scalars(select(Connection)))


def test_collectors_discovering_same_session_reuse_one_record(store, tmp_path):
    id_ = add_connection(store, tmp_path)
    rendezvous = threading.Barrier(2)
    def discover():
        with store() as db:
            c = db.get(Connection, id_)
            scalar = db.scalar
            first_lookup = True
            def simultaneous_lookup(query):
                nonlocal first_lookup
                result = scalar(query)
                if first_lookup:
                    first_lookup = False
                    assert result is None
                    rendezvous.wait(timeout=3)
                return result
            db.scalar = simultaneous_lookup
            session = connectors.get_session(db, c, "shared", "Untitled session",
                                             "2026-09-21T00:00:00+00:00", "desktop")
            db.commit()
            return session.id
    with ThreadPoolExecutor(max_workers=2) as executor:
        ids = list(executor.map(lambda _: discover(), range(2)))
    assert ids[0] == ids[1]
    with store() as db:
        assert db.scalar(select(func.count()).select_from(ChatSession)) == 1


def test_actions_and_other_imports_finish_while_import_is_running(store, tmp_path, monkeypatch):
    first = add_connection(store, tmp_path)
    second = add_connection(store, tmp_path)
    entered, release = threading.Event(), threading.Event()
    calls = []
    def slow_import(db, c, **kwargs):
        calls.append(c.id)
        if c.id == first:
            entered.set()
            assert release.wait(5)
    monkeypatch.setattr(main, "sync_connection", slow_import)
    monkeypatch.setattr(main.hooks, "configure", lambda c, enabled: setattr(c, "hooks_enabled", enabled))
    monkeypatch.setattr(main.hooks, "queue_path", lambda c: tmp_path / c.id)
    client = TestClient(main.app, base_url="http://localhost")
    with ThreadPoolExecutor(max_workers=2) as executor:
        importing = executor.submit(main.synchronize, first)
        try:
            assert entered.wait(2)
            def actions():
                assert client.patch(f"/api/connections/{first}/hooks", json={"enabled": True}).status_code == 200
                assert client.post(f"/api/connections/{first}/sync").json()["status"] == "syncing"
                assert client.post(f"/api/connections/{second}/sync").status_code == 200
                assert client.delete(f"/api/connections/{second}").status_code == 200
                assert client.post("/api/connections", json={"name": "New", "provider": "codex_cli", "path": str(tmp_path)}).status_code == 201
            executor.submit(actions).result(timeout=3)
            assert not importing.done()
            assert calls == [first, second]
        finally:
            release.set()
        importing.result(timeout=3)


@pytest.mark.parametrize("provider", ["codex", "claude_code"])
@pytest.mark.parametrize("action", ["pause", "delete"])
def test_interrupt_import_rolls_back_and_does_not_recreate_records(store, tmp_path, monkeypatch, provider, action):
    if provider == "codex":
        transcript(tmp_path / "rollout.jsonl")
    else:
        fixture(tmp_path)
    id_ = add_connection(store, tmp_path, provider)
    entered = threading.Event()
    original = connectors.check_interrupted
    def wait_for_mutation(db):
        # Interrupt after the importer has created a session in its transaction.
        if db.scalar(select(func.count()).select_from(ChatSession)):
            entered.set()
            assert collection(id_).stop.wait(5)
        original(db)
    monkeypatch.setattr(connectors, "check_interrupted", wait_for_mutation)
    from backend import claude_code
    monkeypatch.setattr(claude_code, "check_interrupted", wait_for_mutation)
    monkeypatch.setattr(main.hooks, "queue_path", lambda c: tmp_path / c.id)
    client = TestClient(main.app, base_url="http://localhost")
    with ThreadPoolExecutor(max_workers=2) as executor:
        importing = executor.submit(main.synchronize, id_)
        try:
            assert entered.wait(2)
            if action == "delete":
                response = executor.submit(client.delete, f"/api/connections/{id_}").result(timeout=3)
            else:
                response = executor.submit(client.patch, f"/api/connections/{id_}", json={"enabled": False}).result(timeout=3)
            assert response.status_code == 200
        finally:
            collection(id_).stop.set()
        importing.result(timeout=3)
        collection(id_).stop.clear()
    with store() as db:
        for model in (ChatSession, Event, Checkpoint):
            assert db.scalar(select(func.count()).select_from(model)) == 0
        c = db.get(Connection, id_)
        if action == "delete":
            assert c is None
        else:
            assert not c.enabled and c.status == "paused" and c.error is None
    monkeypatch.setattr(connectors, "check_interrupted", original)
    monkeypatch.setattr(claude_code, "check_interrupted", original)
    main.synchronize(id_)
    if action == "pause":
        assert client.patch(f"/api/connections/{id_}", json={"enabled": True}).status_code == 200
        main.synchronize(id_)
        with store() as db:
            assert db.scalar(select(func.count()).select_from(Event)) > 0
