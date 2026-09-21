# Setup and troubleshooting

Want to explore first? The [sample dashboard demo](demo.md#the-three-minute-tour) needs no agent or API key and uses isolated storage. The instructions below connect Relay to your own agent activity.

## Prerequisites

Relay is currently documented for Windows and PowerShell. Other operating systems are not claimed as verified release targets. Commands below start in the repository root.

| Dependency | Requirement | Check |
| --- | --- | --- |
| Git | To clone the repository | `git --version` |
| Python | 3.11 or newer | `python --version` |
| uv | Python dependency and environment management | `uv --version` |
| Node.js | 22.12 or newer; supported LTS recommended | `node --version` |
| npm | 10 or newer | `npm --version` |
| Coding agent | Codex Desktop, Codex CLI, or Claude Code with local transcripts; unnecessary for Lab | Check the agent separately |

Python and uv are enough for Relay Lab. The main dashboard also requires Node and npm to build. An agent subscription or login is separate from API credentials for Relay's judge.

## Install and start

Clone the repository using its GitHub Clone URL, then open PowerShell in the cloned directory. Install the locked dependencies:

```powershell
uv sync --locked
Set-Location frontend
npm ci
Set-Location ..
```

Start the application:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

The launcher migrates `data/monitor.db`, builds the frontend, starts two safety worker lanes plus the incident analysis lane, and serves the UI and API at **http://127.0.0.1:8000**. It may use a compatible Codex-bundled Node if present; a normal installation of the required Node version should be available for reproducible setup. Ctrl+C stops the launcher and its safety worker.

Check **http://127.0.0.1:8000/api/health** or run `Invoke-RestMethod http://127.0.0.1:8000/api/health`. An empty dashboard is expected until you add a connection. Safety workers may wait for credentials while transcript monitoring continues normally.

### Manual startup

If you want separate terminal logs, build and start the API in one terminal:

```powershell
uv run --locked alembic upgrade head
Set-Location frontend
npm run build
Set-Location ..
uv run --locked uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

For safety judging and incident analysis, open a second terminal in the repository root:

```powershell
uv run --locked python -m backend.safety_worker --workers 2
```

Use one Uvicorn worker: ingestion and synchronization locks are process-local. Do not run the combined launcher alongside a manually started API or worker. Stop each manual process with Ctrl+C.

## Connect your first agent

1. Open **Connections → Add connection**.
2. Choose **Codex Desktop**, **Codex CLI**, or **Claude Code**.
3. Review the detected source and click **Connect**.
4. Open **Overview**, then a session in **Explorer**. For a live check, start a new agent conversation, send a harmless prompt, and allow time for its transcript to flush and Relay to collect it.

Codex uses `CODEX_HOME` or `~/.codex`; Desktop and CLI sessions are classified separately. Claude Code uses `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. A connection can contain conversations from many projects and terminals. Custom profiles and accessible WSL folders need an explicit source path; Relay does not discover remote hosts.

Monitoring reads source transcripts without modifying them. It does not install hooks or call a model. Deleting a connection removes its imported Relay records, not its source transcripts. Disable live hooks before deleting a connection if you previously enabled them.

## Optional Anthropic credentials

The current judge and incident analysis use `claude-haiku-4-5-20251001`. Live evaluation needs an Anthropic API key with model access and available API credit/quota. Anthropic is the default and recommended provider. OpenAI is also available as an untested alternative.

Choose one configuration method:

- **Key file:** create `.secrets/anthropic.key` under the repository root and paste only the key into it using a local editor. The launcher creates an empty file when needed. Workers reread it without restarting.
- **Environment:** provide `ANTHROPIC_API_KEY` to the API/worker process using your local secret-management method. This takes precedence over the file. Restart existing processes after changing their environment.
- **Alternate key file:** set `RELAY_ANTHROPIC_KEY_FILE` to the absolute path of a file containing the key.

Do not add actual keys to documentation or commits. `.secrets/`, `.env` files, and `*.key` files are ignored. Relay does not automatically load a `.env` file.

Without credentials, model-dependent jobs wait locally; a blocking request still has a deadline and cannot continue just because the key is missing. Deterministic policy paths and explicit debug simulation are separate from model evaluation. Use scripted Lab mode for a predictable key-free demo.

Live safety evaluation sends the proposed action and selected bounded conversation context to the configured judge provider. Incident analysis sends its selected evidence. Limited redaction is applied, but arbitrary sensitive text can remain. Calls incur API charges; usage varies with context, attempts, and incident analysis. Scripted Lab runs make no provider calls.

## Optional live hooks and blocking

Start with transcript monitoring. To observe live hooks, use **Connections → Set up live hooks → Enable live hooks**. Relay updates the provider profile settings and saves a backup. Restart agent sessions and, for Codex, review and trust the handler if prompted. The connection stays **waiting for first hook** until one actually arrives.

For blocking evaluation, use **Safety → Settings → Protection by connection → Configure → Enable blocking Haiku evaluation**. Keep the API and safety worker running and verify a harmless new action before relying on the workflow. Covered requests can wait up to 60 seconds, including human review. An approval or allow verdict proceeds to the agent's native permissions; it does not bypass them. Expired requests need a new action request.

Use **Disable live hooks** to remove Relay's handlers. Deleting a connection alone leaves inert handlers in the provider settings. See [hook coverage](rfc-003-live-hook-observation.md), [blocking boundaries](rfc-005-blocking-safety.md), and [human review](human-review.md).

## Frontend development

Keep the API running on port 8000, then in a second terminal:

```powershell
Set-Location frontend
npm run dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` to the backend. The API's port-8000 frontend uses the last production build, so rebuild to update that version.

## Troubleshooting

| Symptom | Check or next step |
| --- | --- |
| `uv`, Python, Node, or npm not found | Install the prerequisite, reopen the terminal, and check the versions above. |
| Build reports unsupported Node | Put Node 22.12+ on PATH; do not rely on a machine-specific bundled runtime. |
| Missing tables or schema errors | Stop services, back up an existing database, and run `uv run --locked alembic upgrade head`. |
| Port 8000 already in use | Stop the duplicate Relay process or choose another API port. The Vite development proxy assumes port 8000. |
| No sessions after connecting | Check the selected integration, source path, connection error, and **Check source**. Start a new session and verify the agent wrote a transcript. |
| CLI sessions appear missing | Check `CODEX_HOME`, Desktop versus CLI provenance, and whether the path is accessible to the backend. |
| Judge remains waiting | Check worker logs and credentials; environment credentials override the file. |
| Authentication, quota, or model error | Check the configured judge provider API access and quota. Use scripted Lab mode while resolving provider setup. |
| Hook shows no activity | Restart the agent, trust the handler where required, and check **Last received** after a harmless tool call. |
| Blocking action expires | Check API and workers, then inspect the request's timing/error evidence. Expired approvals cannot release an old request. |
| Browser tests cannot start | Build first, install Playwright Chromium, and use an unused `RELAY_E2E_PORT`; see [testing](testing.md). |

Local state defaults to `data/monitor.db`; Lab artifacts live under `data/lab/`. Back up a database with the application and workers stopped. Do not publish databases, hook queues, settings backups, or screenshots of private conversations. This local app is not designed to be exposed on a public interface.

## Optional OpenAI credentials (untested)

OpenAI can power both safety judgments and incident analysis. **Live OpenAI integration and verdict quality have not been tested; Anthropic is recommended.** Offline tests use mocked responses and do not establish live compatibility.

Before starting the API, worker, or live Lab, set the same configuration in each process. In PowerShell:

```powershell
$env:RELAY_JUDGE_PROVIDER = "openai"
```

Create `.secrets/openai.key` and paste only your OpenAI API key into it. Alternatively, set `OPENAI_API_KEY` through your local secret manager (takes precedence), or set `RELAY_OPENAI_KEY_FILE` to another key file. Workers reread key files automatically. Environment changes require restarting the API and workers. Keys are never returned to the browser.

The default OpenAI model is `gpt-4.1`. Override it with `RELAY_JUDGE_MODEL`, using an OpenAI model supporting Responses API function calling. Requests force a structured assessment and disable response storage (`store=false`); returned tools are never executed. Existing timeouts, local validation and fail-closed gate behavior still apply. Verify model access, verdict quality and latency before relying on this option.

Action context and incident evidence go to OpenAI when selected and incur API charges. Limited secret redaction is not comprehensive. There is no automatic provider fallback. Switch after queued work has drained: queued judgments retain their model and fail if it belongs to the other provider. To return to Anthropic, set `RELAY_JUDGE_PROVIDER=anthropic`, remove any OpenAI `RELAY_JUDGE_MODEL` override, and restart both processes.

API format: [OpenAI Responses API](https://developers.openai.com/api/docs/guides/text).
