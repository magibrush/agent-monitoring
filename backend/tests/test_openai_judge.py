"""Offline wire-contract checks; these do not validate live OpenAI compatibility."""
import io
import json
from types import SimpleNamespace
import urllib.error

import pytest

from backend import incident_analysis, judge, judge_provider, safety


@pytest.fixture
def openai(monkeypatch):
    monkeypatch.setattr(judge_provider, "PROVIDER", "openai")
    monkeypatch.setattr(judge, "PROVIDER", "openai")
    monkeypatch.setattr(safety, "PROVIDER", "openai")


def test_credentials_and_redaction(openai, monkeypatch, tmp_path):
    path = tmp_path / "openai.key"
    monkeypatch.setenv("RELAY_OPENAI_KEY_FILE", str(path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-wrong-provider")
    assert safety.read_key() is None
    path.write_text("\ufeffsk-proj-file\n", encoding="utf-8")
    assert safety.read_key() == "sk-proj-file"
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    assert safety.read_key() == "sk-env-key"
    monkeypatch.setenv("OPENAI_API_KEY", "sk-ant-wrong-provider")
    assert safety.read_key() is None
    assert "sk-" not in safety.redact("sk-proj-secret sk-ant-secret sk-legacy")


def mock_response(monkeypatch, result, name="submit_verdict", status="completed"):
    document = {"id": "resp_test", "status": status, "output": [
        {"type": "function_call", "name": name, "arguments": json.dumps(result)}],
        "usage": {"input_tokens": 23, "output_tokens": 17}}
    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "https://api.openai.com/v1/responses"
            assert request.get_header("Authorization") == "Bearer sk-test"
            assert request.get_header("X-api-key") is None
            body = json.loads(request.data)
            assert body["model"] == "gpt-4.1"
            assert body["store"] is False and body["parallel_tool_calls"] is False
            assert body["tool_choice"] == {"type": "function", "name": name}
            assert "untrusted" in body["instructions"]
            assert timeout > 0
            return io.BytesIO(json.dumps(document).encode())
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    return document


def verdict():
    return {"recommendation": "allow", "risk": "low", "suspicious": False,
            "severity": "low", "reason": "Routine read", "evidence": [], "missing_context": []}


def test_openai_verdict_and_validation(openai, monkeypatch):
    document = mock_response(monkeypatch, verdict())
    job = SimpleNamespace(model="gpt-4.1", snapshot={"action_truncated": False}, rules={})
    result, usage = judge.evaluate(job, "sk-test")
    assert result["recommendation"] == "allow" and usage["input_tokens"] == 23
    job.snapshot["action_truncated"] = True
    assert judge.evaluate(job, "sk-test")[0]["recommendation"] == "review"
    document["output"][0]["arguments"] = json.dumps({**verdict(), "recommendation": "execute"})
    with pytest.raises(judge.JudgeError, match="schema validation"):
        judge.evaluate(job, "sk-test")


@pytest.mark.parametrize("status,output", [
    ("incomplete", [{"type": "function_call", "name": "submit_verdict", "arguments": json.dumps(verdict())}]),
    ("completed", [{"type": "message", "content": [{"type": "refusal"}]}]),
    ("completed", [{"type": "function_call", "name": "submit_verdict", "arguments": "not json"}]),
])
def test_openai_invalid_responses_fail_closed(openai, monkeypatch, status, output):
    document = mock_response(monkeypatch, verdict())
    document.update(status=status, output=output)
    with pytest.raises(judge.JudgeError):
        judge.evaluate(SimpleNamespace(model="gpt-4.1", snapshot={}, rules={}), "sk-test")


@pytest.mark.parametrize("code,retryable", [(401, False), (429, True), (503, True)])
def test_openai_errors_hide_secrets(openai, monkeypatch, code, retryable):
    class Opener:
        def open(self, *_args, **_kwargs):
            raise urllib.error.HTTPError("https://api.openai.com", code, "sk-secret", {}, io.BytesIO(b"private"))
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(judge.JudgeError) as exc:
        judge.evaluate(SimpleNamespace(model="gpt-4.1", snapshot={}, rules={}), "sk-test")
    assert exc.value.retryable == retryable
    assert "sk-" not in str(exc.value) and "private" not in str(exc.value)


def test_old_provider_job_is_not_sent(openai, monkeypatch):
    monkeypatch.setattr(judge.urllib.request, "build_opener", lambda *_: pytest.fail("Must not send old job"))
    with pytest.raises(judge.JudgeError, match="does not match"):
        judge.evaluate(SimpleNamespace(model="claude-haiku-4-5-20251001", snapshot={}, rules={}), "sk-test")


def test_openai_incident_analysis(openai, monkeypatch):
    result = {"summary": "Routine activity", "findings": [{"text": "Read", "evidence_ids": [1]}], "recommendations": []}
    mock_response(monkeypatch, result, "submit_analysis")
    job = SimpleNamespace(model="gpt-4.1", evidence={"events": [{"event_id": 1}]})
    actual, usage = incident_analysis.evaluate(job, "sk-test")
    assert actual == result and usage["output_tokens"] == 17
