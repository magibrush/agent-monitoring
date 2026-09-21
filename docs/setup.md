# Setup

These instructions connect your own agents on **Windows with PowerShell** or **Linux with Bash**. For a demo without an agent or key, [start here](../README.md#run-the-sample-demo).

## Install and start

Install [uv](https://docs.astral.sh/uv/) and [Node.js 22.12+ with npm 10+](https://nodejs.org/). The launchers use Python 3.11, which uv downloads if needed. Clone or download the repository and open a terminal in its folder.

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

Linux (Bash):

```bash
bash scripts/start.sh
```

Both launchers install locked Python and frontend dependencies, create the key file if missing, migrate the database, build the dashboard, and start the API and safety workers. The first run needs internet access; subsequent runs synchronize dependencies and rebuild. Neither launcher overwrites an existing key. Open **http://127.0.0.1:8000**. Ctrl+C stops the API and workers. An empty dashboard is expected before connecting an agent. Workers can wait for credentials while transcript monitoring continues.

Use a separate checkout/environment for each OS: Windows uses `.venv/Scripts/python.exe`, while Linux uses `.venv/bin/python`. For WSL, run the Linux commands inside WSL and select transcript paths accessible there.

## Connect an agent

1. Open **Connections → Add connection**.
2. Choose **Codex Desktop**, **Codex CLI**, or **Claude Code**.
3. Check the detected source and click **Connect**.
4. Open a session from **Overview** to read it in **Explorer**.

Choose an agent installed on your host; the available clients can differ by OS.

Relay reads transcripts without changing them. It needs no API key for monitoring. Start a new agent conversation if there is no activity yet; only flushed transcript records can appear.

| Agent | Default source |
| --- | --- |
| Codex Desktop / CLI | `CODEX_HOME` or `~/.codex`; sessions are separated by their original client |
| Claude Code | `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` |

One connection covers multiple projects and terminals. Use the advanced folder option for another profile, archives, or an accessible WSL path. Remote hosts are not discovered. Deleting a connection removes imported Relay records, not source transcripts; disable its live hooks first if enabled.

## Optional Anthropic credentials

Anthropic is the default and recommended provider. Live judging and incident analysis use `claude-haiku-4-5-20251001`. They send selected action and conversation evidence to Anthropic and incur API charges. Redaction is limited, so sensitive text can remain in that evidence. An agent subscription does not supply Relay's API access.

Choose one:

| Method | Configuration |
| --- | --- |
| Key file | Paste only the key into `.secrets/anthropic.key`. The launcher creates the empty file; workers reread it automatically. |
| Environment | Set `ANTHROPIC_API_KEY` for the API and worker. It overrides the file; restart processes after changing it. |
| Alternate file | Set `RELAY_ANTHROPIC_KEY_FILE` to an absolute file path. |

Keep keys out of commits. `.secrets/`, `.env`, and `*.key` are ignored, but Relay does **not** load `.env` files automatically. Without credentials, model jobs wait; blocking requests still expire and deny.

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

## Optional live hooks and blocking

1. Choose **Connections → Set up live hooks → Enable live hooks**. Relay backs up the provider settings and adds its handlers.
2. Restart agent sessions. Review and trust the Codex handler if prompted. Run a harmless tool call and check **Last received**.
3. To hold actions for review, open **Safety → Settings → Protection by connection → Configure → Enable blocking judge evaluation**. Restart agent sessions after changing the hook configuration.
4. Keep the API and worker running; verify a harmless new action.

Covered requests can wait up to **60 seconds**, including [human review](human-review.md). An allow or approval continues to the agent's native permissions. Expired requests must be submitted again. Hooks do not cover every tool or provide a tamper-resistant sandbox.

**Disable live hooks** removes Relay's handlers. Deleting a connection alone leaves inert handlers in the provider settings. See [hook coverage](rfc-003-live-hook-observation.md#outcomes-and-boundaries) and [policy rules](policies.md).

## Manual startup and development

For separate terminal logs, replace the launcher with these commands. Windows (PowerShell):

```powershell
uv sync --locked --python 3.11
uv run --locked alembic upgrade head
Set-Location frontend
npm ci
npm run build
Set-Location ..
uv run --locked uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Linux (Bash):

```bash
uv sync --locked --python 3.11
uv run --locked alembic upgrade head
(cd frontend && npm ci && npm run build)
uv run --locked uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

For judging and incident analysis, run in another terminal at the repository root:

```sh
uv run --locked python -m backend.safety_worker --workers 2
```

The worker command works in both shells. Alternatively, use `scripts/start-worker.ps1` on Windows or `bash scripts/start-worker.sh` on Linux after setup. Create `.secrets/anthropic.key` yourself if you use only manual startup and want file-based credentials.

Use **one Uvicorn worker**. Do not run these processes alongside the combined launcher. For frontend development, run `npm run dev` in `frontend/` and open **http://127.0.0.1:5173**; it proxies `/api` to port 8000. Port 8000 serves the last production build.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Runtime missing or unsupported | Check `uv --version`, `node --version`, and `npm --version`; update and reopen your terminal. The launchers provision Python through uv. |
| Missing tables or schema errors | Stop services, back up the database, then run `uv run --locked alembic upgrade head`. |
| Port 8000 occupied | Stop the duplicate process or change the manual API port. The Vite proxy expects 8000. |
| No sessions | Use **Check source**; check the profile, integration, and path. Confirm the agent wrote a new transcript. |
| Judge waiting or failing | Check worker logs, the configured provider credentials, model access, and quota. Environment credentials override the file. |
| No hook activity | Restart the agent, trust the handler if required, then check **Last received** after a harmless tool call. |
| Blocking action expires | Check the API/worker and request timing/error evidence, then submit a new request. |

Health: **http://127.0.0.1:8000/api/health**. API reference: **http://127.0.0.1:8000/docs**. For test setup, see [testing](testing.md).

Local conversations are plaintext in `data/monitor.db`; Lab runs live under `data/lab/`. Stop the API and workers before backing up databases. Keep databases, hook queues, settings backups, and private screenshots out of published materials. Bind this single-user app to loopback only.
