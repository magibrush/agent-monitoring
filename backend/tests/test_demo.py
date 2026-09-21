from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from backend import demo, main, runtime, safety
from backend.db import Connection, Event, Incident, SafetyEvaluation, make_engine
from backend.tests.test_monitor import store


@pytest.fixture
def sample(store, monkeypatch):
    monkeypatch.setattr(runtime, "DEMO", True)
    with store() as db:
        monkeypatch.setattr(runtime, "DEMO_DB", Path(db.get_bind().url.database))
        demo.seed(db)
    return store


def client():
    return TestClient(main.app, base_url="http://localhost")


def test_demo_database_ignores_personal_database_url(tmp_path, monkeypatch):
    personal = tmp_path / "personal.db"
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + personal.as_posix())
    monkeypatch.setattr(runtime, "DEMO", True)
    monkeypatch.setattr(runtime, "DEMO_DB", tmp_path / "demo" / "monitor.db")
    engine = make_engine()
    assert Path(engine.url.database) == runtime.DEMO_DB
    assert not personal.exists()
    engine.dispose()


def test_seed_refuses_normal_database_even_in_demo_mode(store, monkeypatch, tmp_path):
    monkeypatch.setattr(runtime, "DEMO", True)
    monkeypatch.setattr(runtime, "DEMO_DB", tmp_path / "separate-demo.db")
    with store() as db:
        db.add(Connection(name="Keep me", provider="codex", path="")); db.commit()
        with pytest.raises(RuntimeError, match="Refusing"):
            demo.seed(db)
        assert db.scalar(select(Connection.name)) == "Keep me"


def test_demo_never_discovers_sources_collects_hooks_or_reads_keys(sample, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Demo touched a personal integration")
    monkeypatch.setattr(main, "default_path", forbidden)
    monkeypatch.setattr(main, "sync_connection", forbidden)
    monkeypatch.setattr(main.hooks, "collect", forbidden)
    monkeypatch.setattr(safety, "key_path", forbidden)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-synthetic-not-a-real-key")
    assert safety.read_key() is None
    main.synchronize()
    main.synchronize_hooks()
    with client() as c:
        assert c.get("/api/config").json()["sources"] == []
        assert c.get("/api/health").json()["demo"] is True


@pytest.mark.parametrize("method,path", [
    ("post", "/api/connections"),
    ("post", "/api/connections/check"),
    ("patch", "/api/connections/demo-codex"),
    ("delete", "/api/connections/demo-codex"),
    ("post", "/api/connections/demo-codex/sync"),
    ("get", "/api/connections/demo-codex/hooks"),
    ("get", "/api/connections/demo-codex/hooks/"),
    ("patch", "/api/connections/demo-codex/hooks"),
    ("put", "/api/safety/debug"),
    ("post", "/api/safety/evaluations/demo-eval-upload/retry"),
    ("post", "/api/safety/evaluations/demo-eval-push/review"),
    ("post", "/api/policies/draft"),
    ("post", "/api/safety/incidents/demo-incident-upload/actions"),
])
def test_demo_rejects_live_mutations(sample, method, path):
    response = getattr(client(), method)(path)
    assert response.status_code == 403
    assert "synthetic demo" in response.json()["detail"]


def test_walkthrough_evidence_notes_resolution_and_reset(sample):
    c = client()
    sessions = c.get("/api/sessions").json()
    assert sessions["total"] == 4
    url = "/api/safety/incidents/demo-incident-upload"
    detail = c.get(url).json()
    assert "keep customer data local" in detail["analysis"]["result"]["summary"]
    assert not detail["analysis"]["stale"]
    assert c.post(url + "/notes", json={"text": "I reviewed the fictional evidence."}).status_code == 201
    assert c.patch(url, json={"revision": detail["revision"], "status": "resolved", "resolution": "dismissed"}).status_code == 200
    assert c.get(url).json()["status"] == "resolved"
    assert c.post("/api/demo/reset").status_code == 200
    restored = c.get(url).json()
    assert restored["status"] == "new"
    assert not any(item["text"] == "I reviewed the fictional evidence." for item in restored["activity"])
    assert c.post("/api/demo/reset").status_code == 200
    with sample() as db:
        assert db.scalar(select(func.count()).select_from(Incident)) == 2
        assert db.scalar(select(func.count()).select_from(SafetyEvaluation)) == 4
        assert db.scalar(select(func.count()).select_from(Event)) == 18
        assert all(not row.enabled and not row.hooks_enabled and not row.gate_enabled and row.path is None for row in db.scalars(select(Connection)))
        assert all(row.status == "completed" for row in db.scalars(select(SafetyEvaluation)))


def test_reset_unavailable_in_normal_mode(store, monkeypatch):
    monkeypatch.setattr(runtime, "DEMO", False)
    assert client().post("/api/demo/reset").status_code == 404
