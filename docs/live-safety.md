# Live safety review (optional)

[← Setup](setup.md) · [All documentation](README.md)

Complete [setup](setup.md) first. For the recommended Anthropic setup, follow the three steps below. [Other credential methods](#advanced-credential-options) and [OpenAI (untested)](#optional-openai-credentials-untested) are at the end.

Live judging and incident analysis send selected action and conversation evidence to Anthropic and incur API charges. Redaction is limited, so sensitive text can remain. An agent subscription does not supply Relay's API access. The default model is `claude-haiku-4-5-20251001`.

## 1. Add your Anthropic key

Paste **only the key** into `.secrets/anthropic.key` in the repository folder. The launcher created this empty file; running workers reread it automatically.

Keep keys out of commits. Without credentials, model jobs wait; blocking requests still expire and deny. If you previously set `ANTHROPIC_API_KEY`, it overrides this file; see [advanced options](#advanced-credential-options).

## 2. Enable live hooks

1. Choose **Connections → Set up live hooks → Enable live hooks**. Relay backs up the provider settings and adds its handlers.
2. Restart agent sessions. Review and trust the Codex handler if prompted.
3. Run a harmless tool call and confirm **Last received** updates.

## 3. Enable blocking (optional)

1. Open **Safety → Settings → Protection by connection → Configure → Enable blocking judge evaluation**.
2. Restart agent sessions after changing the hook configuration.
3. Keep the API and worker running. Submit a harmless new action and check its recorded review result in **Safety**.

Covered requests can wait up to **60 seconds**, including [human review](human-review.md). An allow or approval continues to the agent's native permissions; it does not prove execution succeeded. Expired requests must be submitted again. Hooks do not cover every tool or provide a tamper-resistant sandbox, and model judgments can be wrong.

**To disconnect:** use **Disable live hooks** to remove Relay's handlers. Deleting a connection alone leaves inert handlers in the provider settings.

[Review not working?](setup-reference.md#troubleshooting) · [Policy rules](policies.md) · [Hook coverage](rfc-003-live-hook-observation.md#outcomes-and-boundaries)

## Advanced credential options

The key file above is sufficient for the recommended setup. Alternatives:

| Method | Configuration |
| --- | --- |
| Environment | Set `ANTHROPIC_API_KEY` for the API and worker. It overrides the file; restart processes after changing it. |
| Alternate file | Set `RELAY_ANTHROPIC_KEY_FILE` to an absolute file path. |

`.secrets/`, `.env`, and `*.key` are ignored, but Relay does **not** load `.env` files automatically.

## Optional OpenAI credentials (untested)

OpenAI can power both safety judgments and incident analysis. **Live OpenAI integration and verdict quality have not been tested; Anthropic is recommended.** Offline tests use mocked responses and do not establish live compatibility.

Before starting the API, worker, or live Lab, set the same configuration in each process. In PowerShell:

```powershell
$env:RELAY_JUDGE_PROVIDER = "openai"
```

Linux (Bash):

```bash
export RELAY_JUDGE_PROVIDER=openai
```

Create `.secrets/openai.key` and paste only your OpenAI API key into it. Alternatively, set `OPENAI_API_KEY` through your local secret manager (takes precedence), or set `RELAY_OPENAI_KEY_FILE` to another key file. Workers reread key files automatically. Environment changes require restarting the API and workers. Keys are never returned to the browser.

The default OpenAI model is `gpt-4.1`. Override it with `RELAY_JUDGE_MODEL`, using an OpenAI model supporting Responses API function calling. Requests force a structured assessment and disable response storage (`store=false`); returned tools are never executed. Existing timeouts, local validation and fail-closed gate behavior still apply. Verify model access, verdict quality and latency before relying on this option.

Action context and incident evidence go to OpenAI when selected and incur API charges. Limited secret redaction is not comprehensive. There is no automatic provider fallback. Switch after queued work has drained: queued judgments retain their model and fail if it belongs to the other provider. To return to Anthropic, set `RELAY_JUDGE_PROVIDER=anthropic`, remove any OpenAI `RELAY_JUDGE_MODEL` override, and restart both processes.

API format: [OpenAI Responses API](https://developers.openai.com/api/docs/guides/text).

