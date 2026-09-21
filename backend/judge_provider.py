"""Explicit judge configuration and provider wire formats (no automatic fallback)."""
import json
import os
import urllib.request

PROVIDER = os.getenv("RELAY_JUDGE_PROVIDER", "anthropic").strip().lower()
if PROVIDER not in {"anthropic", "openai"}:
    raise ValueError("RELAY_JUDGE_PROVIDER must be anthropic or openai")
MODEL = os.getenv("RELAY_JUDGE_MODEL", "gpt-4.1" if PROVIDER == "openai" else "claude-haiku-4-5-20251001").strip()


def make_request(body, key):
    # Queued jobs retain their model. Never send an old provider's job/key to another API.
    if (body["model"].startswith("claude-") != (PROVIDER == "anthropic")):
        raise ValueError("Queued judge model does not match the configured provider")
    if PROVIDER == "anthropic":
        url = "https://api.anthropic.com/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    else:
        url = "https://api.openai.com/v1/responses"
        headers = {"Authorization": f"Bearer {key}"}
        tool = body["tools"][0]
        body = {"model": body["model"], "instructions": body["system"],
                "input": body["messages"], "max_output_tokens": body["max_tokens"],
                "store": False, "parallel_tool_calls": False,
                "tools": [{"type": "function", "name": tool["name"],
                           "description": tool["description"], "parameters": tool["input_schema"],
                           "strict": tool.get("strict", False)}],
                "tool_choice": {"type": "function", "name": tool["name"]}}
    return urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers}, method="POST")


def normalize_response(document):
    if PROVIDER == "anthropic":
        return document
    blocks = [{"type": "tool_use", "name": item.get("name"),
               "input": json.loads(item["arguments"])}
              for item in document.get("output", []) if item.get("type") == "function_call"]
    return {"id": document.get("id"), "usage": document.get("usage", {}),
            "stop_reason": "tool_use" if document.get("status") == "completed" else "incomplete",
            "content": blocks}
