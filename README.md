# Relay

A local agent monitoring app: React + TypeScript frontend, Python API, and SQLite chat storage.

## What works

- Dashboard with activity charts, prompt/answer counts, and recorded tool-call totals.
- Multiple named connections and independently identified chat sessions.
- Provider, connection, time-range, and full-text search filters; sorting and pagination.
- Select sessions to aggregate their metrics; open complete paginated conversations and tool records.
- Codex Desktop local transcript watcher, with durable checkpoints, pause/resume, sync errors, and manual sync.
- Local-only HTTP access, SQLite WAL, SQLAlchemy models, Alembic migrations, and tests.

Codex Desktop is the only supported integration. Enforcement workers are **not** implemented. Codex integration depends on the local transcript format and only includes Desktop-identified records. Recorded tool calls do not prove success. Read the [ingestion and enforcement research](docs/ingestion-and-enforcement.md) before building the security layer.

## Stack choices

| Layer | Choice | Reason |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite | A local dashboard needs client-side interaction; no server rendering requirement |
| Data and charts | TanStack Query, Recharts | Shared query state, polling, filtering, SVG charts |
| UI | Custom CSS, Lucide icons | Restrained light interface, no heavy component framework |
| API | FastAPI, Pydantic | Typed request validation and generated API reference |
| Persistence | SQLite WAL, SQLAlchemy 2, Alembic | Simple local setup, durable identity, controlled schema changes |
| Later | PostgreSQL + transactional outbox | Multiple workers/hosts and stronger concurrent ingestion |

The SQLite database lives at `data/monitor.db`. It contains private chat text and relevant raw provider records in plaintext. The app does not make model API calls or require API keys. Source files are only read; connecting does not modify the desktop apps. Bind to loopback only; this is a single-user local app, not a secured multi-user deployment.

## Run on Windows

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/), Node 22.12+ (or a supported newer LTS), and npm 10+.

```powershell
uv sync
uv run alembic upgrade head
cd frontend
npm ci
npm run build
cd ..
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**. The Python service serves the built frontend and API from the same origin. Run only **one** Uvicorn worker in this version; the collector is in-process and write serialization is process-local.

After installing dependencies, you can also launch everything with `powershell -ExecutionPolicy Bypass -File scripts/start.ps1` from the project root.

For frontend development, run the same Python service plus `npm run dev` in `frontend`, then open **http://127.0.0.1:5173**. Vite proxies `/api` to port 8000. API reference: **http://127.0.0.1:8000/docs**.

If the system Node is old, use a newer Node in PATH. Codex installations may provide a compatible bundled Node under `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`. `scripts/start.ps1` can use that runtime automatically after dependencies are installed.

### Add Codex Desktop

1. Click **Add connection → Codex Desktop**.
2. Use the suggested `$CODEX_HOME/sessions` directory (defaults to `~/.codex/sessions`).
3. Save. The collector reads complete records every three seconds; the UI refreshes every four seconds.
4. Use **Connections** to pause, resume, or sync manually. Archived transcripts can be connected separately through their own directory.

Choose the actual sessions directory, not the whole home directory. Desktop provenance is required; CLI and VS Code extension-only records are excluded. Large initial histories may take several cycles. Missing/malformed/replaced transcripts surface errors; unknown event types are not counted. If the provider changes its schema, update the adapter and validate against fixtures before reimporting.

### Metric definitions

“Questions” means user prompt messages, including requests without question marks. “Answers” means assistant messages, including commentary. “Actions” means recognized tool-call records, excluding tool outputs. Session count means sessions with observed events in the selected range. Dates are stored in UTC; charts use UTC calendar days and list timestamps use your browser locale. Session list last activity is lifetime activity, while counts follow the selected time window. The conversation viewer shows full session history.

Search matches session titles or message/tool text. Charts aggregate all events in matching sessions within the selected period; selecting checkboxes narrows chart totals to those sessions. A connection and provider filter combine with AND. Separate connections can intentionally contain overlapping source data.

## Verify

```powershell
uv run pytest -q
cd frontend
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser test config starts a separate backend on port 8000 with an isolated `data/e2e.db`. Stop the normal server first. Browser tests require a frontend build and the `.venv` created by `uv sync`; tests reset only their isolated database. On this machine, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point to an already installed Chromium executable.

Backend tests cover replay/restarts, partial writes, mirrored-message deduplication, identity isolation, tool correlation, rollback, pause behavior, API filters, paging, and cross-origin rejection. Browser tests exercise the real API with synthetic sources.

## Layout

```text
backend/
  connectors.py   Read-only Codex transcript collector
  db.py           Relational models and SQLite configuration
  main.py         API and background collector
  migrations/     Versioned schema migrations
  tests/          Integration and ingestion tests
frontend/
  src/            UI, charts, query state, and styling
  tests/          Browser workflows
docs/
  ingestion-and-enforcement.md
scripts/
  start.ps1       Build, migrate, and serve locally
```

## Retired integrations

Claude Desktop export importing has been removed. Any previously imported records remain in the local database, but are excluded from all monitoring views and cannot be accessed through the API. Database files and local transcripts are never tracked in Git. Claude Code remains a possible future integration, covered in the design notes.
