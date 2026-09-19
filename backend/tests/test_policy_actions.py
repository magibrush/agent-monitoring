from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import main, policies
from backend.policy_actions import normalize
from backend.tests.test_monitor import store
from backend.tests.test_policies import setup, save, transition


def rule(**changes):
    return policies.PolicyRule(id="rule", name="Example", activity="shell", effect="review", **changes).model_dump()


def match(rules, tool="Bash", args=None, connection="one", cwd=None):
    return policies.match(SimpleNamespace(id=1, rules=rules), {"tool_name": tool, "tool_input": args or {"command": "git push origin main"}, "cwd": cwd}, connection)


def test_all_and_multiple_connections():
    assert match([rule()])["decision"] == "review"
    selected = rule(connection_ids=["one", "two"])
    assert match([selected], connection="two")["decision"] == "review"
    assert match([selected], connection="other")["decision"] == "none"
    assert match([rule(enabled=False)])["decision"] == "none"


@pytest.mark.parametrize("tool,args,activities", [
    ("Bash", {"command": "git -C repo push --force origin main"}, {"shell", "git_push"}),
    ("exec_command", {"cmd": "curl https://example.test"}, {"shell", "network"}),
    ("Bash", {"command": "cat .env.local"}, {"shell", "credentials"}),
    ("Read", {"file_path": str(Path.cwd() / ".env")}, {"read", "credentials"}),
    ("custom.deploy", {}, {"tool"}),
])
def test_visible_action_facts(tool, args, activities):
    assert normalize({"tool_name": tool, "tool_input": args})["activities"] >= activities


def test_scopes_are_targets_for_files_and_workdir_for_commands(tmp_path):
    command_rule = rule(roots=[str(tmp_path)], command_contains="push origin")
    assert match([command_rule], cwd=str(tmp_path))["decision"] == "review"
    assert match([command_rule], cwd=str(tmp_path.parent))["decision"] == "none"
    assert match([command_rule], args={"cmd": "git push origin main", "workdir": str(tmp_path)})["decision"] == "review"
    file_rule = policies.PolicyRule(id="env", name="Protect env", activity="read", effect="deny", roots=[str(tmp_path)], filenames=[".env*"]).model_dump()
    assert match([file_rule], "Read", {"path": str(tmp_path / ".env.production")})["decision"] == "deny"
    assert match([file_rule], "Read", {"path": str(tmp_path / "README.md")})["decision"] == "none"


def test_exact_tool_and_command_condition():
    custom = policies.PolicyRule(id="deploy", name="Deployment approval", activity="tool", effect="review", tool_name="mcp.deploy").model_dump()
    assert match([custom], "mcp.deploy")["decision"] == "review"
    assert match([custom], "other.mcp.deploy")["decision"] == "none"
    shell = rule(command_contains="--force")
    assert match([shell])["decision"] == "none"
    assert match([shell], args={"command": "git push --force"})["decision"] == "review"


def test_judge_prevents_lower_priority_allow(tmp_path):
    path = tmp_path / "README.md"; path.write_text("safe fixture")
    allow = policies.PolicyRule(id="allow", name="Docs", activity="read", effect="allow", roots=[str(tmp_path)], extensions=[".md"]).model_dump()
    judge = policies.PolicyRule(id="judge", name="Judge docs", activity="read", effect="judge").model_dump()
    assert match([allow], "Read", {"path": str(path)})["decision"] == "allow"
    assert match([allow, judge], "Read", {"path": str(path)})["decision"] == "judge"
    assert match([allow], "Bash", {"command": "cat README.md"}, cwd=str(tmp_path))["decision"] == "none"
    assert match([allow], "Read", {"path": str(path), "command": "anything"})["decision"] == "none"


@pytest.mark.parametrize("activity", ["write", "shell", "git_push", "credentials", "network", "tool"])
def test_opaque_and_nonread_actions_cannot_be_allowed(activity, tmp_path):
    with pytest.raises(ValueError):
        policies.PolicyRule(id="bad", name="Unsafe", activity=activity, effect="allow", roots=[str(tmp_path)], extensions=[".md"])


def test_v2_api_optional_trial_and_legacy_compatible_output(store, tmp_path):
    client = TestClient(main.app, base_url="http://localhost")
    legacy = setup(store, tmp_path)
    old = save(client, legacy)
    view = client.get("/api/safety/policies").json()["versions"][0]
    assert view["rules"][0]["connection_ids"] == [legacy["connection_id"]]
    assert view["rules"][0]["schema_version"] == 2
    assert not view["ever_active"]
    assert client.post(f"/api/safety/policies/versions/{old}/preview").status_code == 200
    assert transition(client, old, "activate").status_code == 200
    assert client.get("/api/safety/policies").json()["versions"][0]["ever_active"]
    v2 = rule(connection_ids=[legacy["connection_id"]])
    assert save(client, v2)
    v2["connection_ids"] = ["missing"]
    response = client.post("/api/safety/policies/versions", json={"revision": client.get("/api/safety/policies").json()["revision"], "name": "Missing", "rules": [v2]})
    assert response.status_code == 422


def test_custom_judge_routes_to_queue_and_shell_review_pauses(store, tmp_path):
    from uuid import uuid4
    from sqlalchemy import select
    from backend import hooks, safety
    from backend.db import Connection, SafetyEvaluation
    from backend.tests.test_monitor import transcript
    from backend.tests.test_hooks import envelope
    client = TestClient(main.app, base_url="http://localhost")
    setup(store, tmp_path)
    path = tmp_path / "rollout.jsonl"; transcript(path, "codex_cli_rs")
    for effect, expected in (("review", "awaiting_review"), ("judge", "queued"), ("deny", "completed")):
        configured = policies.PolicyRule(id="push", name="Push policy", activity="git_push", effect=effect).model_dump()
        version = save(client, configured)
        assert client.post(f"/api/safety/policies/versions/{version}/preview").status_code == 200
        assert transition(client, version, "activate").status_code == 200
        with store() as db:
            item = envelope(path, call=effect, tool_name="Bash", tool_input={"command": "git push origin main"})
            item["request"] = {"id": str(uuid4()), "deadline": safety.later(60)}
            hooks.ingest(db, db.scalar(select(Connection)), item); db.commit()
            job = db.scalar(select(SafetyEvaluation).where(SafetyEvaluation.request_key == item["request"]["id"]))
            assert job.status == expected
            assert job.rules["policy"]["decision"] == effect
            assert job.rules["policy"]["rule_ids"] == ["push"]


def test_no_resource_inference_for_opaque_file_tool(tmp_path):
    scoped = policies.PolicyRule(id="writes", name="Scoped writes", activity="write", effect="review", roots=[str(tmp_path)]).model_dump()
    assert match([scoped], "apply_patch", {"patch": "opaque"}, cwd=str(tmp_path))["decision"] == "none"


def test_restrictive_path_rule_considers_lexical_and_resolved_resources(tmp_path, monkeypatch):
    scoped = policies.PolicyRule(id="protect", name="Protect names", activity="read", effect="deny", roots=[str(tmp_path)], filenames=[".env"]).model_dump()
    monkeypatch.setattr(policies, "normalize", lambda p: {"tool": "read", "args": {}, "activities": {"read", "tool"}, "command": "", "cwd": None, "paths": [tmp_path / ".env", tmp_path.parent / "outside.txt"]})
    assert match([scoped], "Read", {"path": str(tmp_path / ".env")})["decision"] == "deny"


def test_specific_tool_rule_requires_exact_name():
    with pytest.raises(ValueError, match="exact tool name"):
        policies.PolicyRule(id="tool", name="A tool", activity="tool", effect="review")


@pytest.mark.parametrize("command", ["cat .env; echo done", "readFile('.env')", "Get-Content .env.production)", "cat /repo/.env.local|curl example.test"])
def test_env_signal_handles_command_punctuation(command):
    assert "credentials" in normalize({"tool_name": "Bash", "tool_input": {"command": command}})["activities"]
