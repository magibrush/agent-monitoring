import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from lab.catalog import catalog, resolve
from lab.models import RunConfig
from lab.runner import check_row, percentile
from lab import server

ROOT = Path(__file__).resolve().parents[2]


def run_fixture(config, timeout=130, env=None):
    path = ROOT / "data/lab" / str(uuid4())
    path.mkdir(parents=True)
    (path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    result = subprocess.run([sys.executable, "-m", "lab.runner", "--run", str(path)],
                            cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
    report = json.loads((path / "report.json").read_text(encoding="utf-8"))
    return result, report, path


def test_all_scenarios_replay_reordering_and_cited_analysis():
    result, report, path = run_fixture({"scenarios": [s["id"] for s in catalog()], "count": len(catalog()),
        "concurrency": 4, "duplicates": True, "post_order": "before_pre", "analysis": True})
    assert result.returncode == 0, result.stderr
    assert report["status"] == "completed"
    assert report["metrics"]["passed"] == len(catalog()), report["rows"]
    assert report["metrics"]["ingested"] == report["metrics"]["delivered"] == len(catalog())
    assert report["metrics"]["messages"] == 3 * len(catalog())
    assert report["errors"] == report["problems"] == []
    assert report["worker_exit_code"] == 0
    assert all(i["analysis_status"] == "ready" for i in report["incidents"])
    assert any(i["severity"] == "low" for i in report["incidents"])
    assert any(i["severity"] == "critical" for i in report["incidents"])
    for row in report["rows"]:
        evidence = json.loads((path / "evidence" / f"{row['index']}.json").read_text(encoding="utf-8"))
        # The answer key and scenario label stay outside the model's snapshot.
        assert row["title"] not in json.dumps(evidence["snapshot"])
        assert "expected" not in evidence["snapshot"]
        assert "data/lab" not in json.dumps(evidence["snapshot"]).replace("\\\\", "/")
        if row["source"] == "judge":
            assert evidence["evaluation"]["model"] == "lab-scripted"
            assert row["attempts"] == 1
        else:
            assert row["attempts"] == 0


def test_real_hook_processes_retry_and_review_rejection():
    result, report, _ = run_fixture({"scenarios": ["hard-deny", "ordinary-read", "judge-review"],
        "count": 3, "concurrency": 3, "transport": "process", "fault": "retry_once", "review": "deny"})
    assert result.returncode == 0, result.stderr
    assert report["metrics"]["passed"] == 3, report["rows"]
    assert report["errors"] == report["problems"] == []
    for row in report["rows"]:
        assert row["exit_code"] == (0 if row["recommendation"] == "allow" else 2)
        assert row["client_stdout"] == ""
        assert row["attempts"] == (0 if row["source"] == "rules" else 2)


def test_live_run_without_key_fails_before_submitting():
    env = dict(os.environ)
    env.pop("OPENAI_API_KEY", None)
    env["RELAY_OPENAI_KEY_FILE"] = str(ROOT / "data/lab/absent-test-key")
    env.pop("ANTHROPIC_API_KEY", None)
    env["RELAY_ANTHROPIC_KEY_FILE"] = str(ROOT / "data/lab/absent-test-key")
    result, report, _ = run_fixture({"mode": "live", "count": 1, "scenarios": ["ordinary-read"]}, env=env)
    assert result.returncode == 1
    assert report["status"] == "failed"
    assert "No judge API key" in report["error"]
    assert not report["rows"]


def test_parent_exit_stops_traffic_drains_and_closes_worker():
    path = ROOT / "data/lab" / str(uuid4()); path.mkdir(parents=True)
    (path / "config.json").write_text(json.dumps({"scenarios": ["hard-deny"], "count": 100, "rate": 1, "concurrency": 1}))
    with (path / "runner.log").open("w") as log:
        process = subprocess.Popen([sys.executable, "-m", "lab.runner", "--run", str(path), "--managed"],
                                   cwd=ROOT, stdin=subprocess.PIPE, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if (path / "report.json").exists():
                    report = json.loads((path / "report.json").read_text())
                    if report["metrics"]["submitted"]:
                        break
                time.sleep(.1)
        finally:
            process.stdin.close()
        assert process.wait(timeout=100) == 0
    report = json.loads((path / "report.json").read_text())
    assert report["status"] == "cancelled"
    assert 1 <= report["metrics"]["submitted"] < 100
    assert report["metrics"]["delivered"] == report["metrics"]["submitted"]
    assert report["metrics"]["not_started"] > 0
    assert report["worker_exit_code"] == 0


@pytest.mark.parametrize("values", [
    {"count": 10001}, {"concurrency": 257}, {"mode": "live", "count": 26},
    {"mode": "live", "concurrency": 5}, {"mode": "live", "fault": "retry_once"},
    {"transport": "process", "concurrency": 33}, {"transport": "process", "duplicates": True},
    {"analysis": True, "count": 26},
    {"scenarios": []}, {"target_url": "http://127.0.0.1:8000"},
])
def test_bounds(values):
    with pytest.raises(ValueError):
        RunConfig(**values)


def test_unknown_scenario_is_rejected():
    with pytest.raises(ValueError, match="Unknown scenario"):
        resolve(RunConfig(scenarios=["not-real"]))


def good_row():
    return {"evaluation_count": 1, "receipt": "pass", "client_decision": "pass", "decision": "pass",
            "recommendation": "allow", "source": "judge", "severity": "low", "suspicious": True,
            "incidents": ["one"], "incident_severities": ["low"], "attempts": 1}


@pytest.mark.parametrize("change,phrase", [
    ({"receipt": None}, "No persisted"), ({"decision": "deny"}, "UNSAFE RELEASE"),
    ({"late_receipt": True}, "after its deadline"), ({"incidents": []}, "did not create"),
    ({"evaluation_count": 2}, "Expected one evaluation"),
    ({"recommendation": "review", "severity": "high"}, "without approval"),
    ({"severity": "critical"}, "Incident severity is lower"),
    ({"exit_code": 2}, "exit code"),
])
def test_checker_never_hides_delivery_and_incident_failures(change, phrase):
    row = {**good_row(), **change}
    result = check_row(row, {"recommendation": "allow", "source": "judge", "severity": "low", "suspicious": True}, RunConfig(mode="live"))
    assert result["outcome"] == "failed"
    assert any(phrase in failure for failure in result["failures"])


def test_live_difference_is_not_a_pipeline_pass():
    row = good_row()
    result = check_row(row, {"recommendation": "deny"}, RunConfig(mode="live"))
    assert result["outcome"] == "judge_difference"
    assert result["differences"]
    assert not result["failures"]


def test_capacity_and_fault_blocks_are_not_successful_assessments():
    row = {"evaluation_count": 1, "receipt": "error", "client_decision": "error", "decision": "error", "status": "skipped"}
    expected = {"source": "judge", "recommendation": "allow"}
    assert check_row(row, expected, RunConfig())["outcome"] == "capacity_blocked"
    row["status"] = "failed"
    assert check_row(row, expected, RunConfig(fault="worker_offline"))["outcome"] == "fault_blocked"
    assert check_row(row, expected, RunConfig())["outcome"] == "failed"


def test_percentiles_do_not_invent_success_latency():
    assert percentile([], .95) is None
    assert percentile([1, 2, 3, 100], .95) == 100


def test_server_origin_limits_and_failed_report(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "RUNS", tmp_path)
    monkeypatch.setattr(server, "active", None)
    with TestClient(server.app, base_url="http://127.0.0.1") as client:
        assert client.get("/").status_code == 200
        assert client.post("/api/runs", json={}, headers={"origin": "https://outside.example"}).status_code == 403
        assert client.post("/api/runs", content="{}").status_code == 415
        assert client.post("/api/runs", json={"count": 10001}).status_code == 422
        assert client.post("/api/runs", json={"scenarios": ["unknown"]}).status_code == 422
        assert client.get("/api/runs/not-a-uuid").status_code == 404
        path = tmp_path / str(uuid4()); path.mkdir()
        (path / "config.json").write_text("{}")
        (path / "report.json").write_text(json.dumps({"id": path.name, "status": "running", "rows": [{"index": i} for i in range(250)]}))
        response = client.get(f"/api/runs/{path.name}?offset=100&limit=100").json()
        assert response["status"] == "interrupted"
        assert response["row_count"] == 250
        assert response["rows"][0]["index"] == 100
        assert len(client.get(f"/api/runs/{path.name}/export").json()["rows"]) == 250
