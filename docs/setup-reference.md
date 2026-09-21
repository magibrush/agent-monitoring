# Setup reference

[← Setup](setup.md) · [Live safety review](live-safety.md)

## Launcher behavior

The start launchers install locked dependencies, create an empty `.secrets/anthropic.key` if missing, migrate the database, build the dashboard, and start the API and safety workers. They never overwrite an existing key. Subsequent runs synchronize dependencies and rebuild. Workers can wait for credentials while monitoring continues.

Use a separate checkout/environment for each OS: Windows uses `.venv/Scripts/python.exe`, while Linux uses `.venv/bin/python`. For WSL, run Linux commands inside WSL and choose transcript paths accessible there.

## Agent sources

| Agent | Default source |
| --- | --- |
| Codex Desktop / CLI | `CODEX_HOME` or `~/.codex`; sessions are separated by their original client |
| Claude Code | `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` |

One connection covers multiple projects and terminals. Use the advanced folder option for another profile, archives, or an accessible WSL path. Remote hosts are not discovered. Deleting a connection removes imported Relay records, not source transcripts; disable its live hooks first if enabled.

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
