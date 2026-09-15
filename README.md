# Relay

A local agent monitoring app: React + TypeScript frontend, Python API, and SQLite chat storage.

## What works

- Dashboard with activity charts, prompt/answer counts, and recorded tool-call totals.
- Multiple named connections and independently identified chat sessions.
- Connection, precise time-range, message/tool search, and action-category filters; sorting and pagination.
- Select sessions to aggregate their metrics; explore conversations and tool records in a separate split-view Explorer.
- Aligned action/message charts, logarithmic or linear scale, drag-to-zoom, and exact manual bucket sizes.
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

“Questions” means user prompt messages, including requests without question marks. “Answers” means assistant messages, including commentary. Injected setup context is excluded from these counts and preserved for inspection. “Actions” means recognized tool-call records, excluding tool outputs; these records do not prove an action succeeded. Session count means sessions with observed events in the selected range. Session list last activity is lifetime activity; message and action counts follow the selected window.

### Time, selection, and exploration

- **Fit activity** uses the actual event timestamps of matching/selected sessions. Automatic buckets target roughly 100 points, from one minute through one year. Empty buckets show zero activity. Thirty-day and year buckets are fixed durations, not calendar month/year boundaries. Data is stored in UTC; dates and chart labels display in your browser timezone.
- The **time-range picker** offers recent presets and precise custom start/end dates and times. The end is exclusive. A range filters sessions to those with activity in it, then limits their counts and conversation records. Presets capture a fixed window at the moment you select them.
- **Overview checkboxes** immediately restrict the chart and totals. Changing global filters clears that selection. Drag-to-zoom and Earlier/Later change only the chart viewport. Explicit resolution is honored: ranges exceeding 600 buckets show a paged window at that resolution. The compact navigator always shows the full filtered timeline; drag its handles to resize or its middle to pan, with updates on release. Arrow keys move focused handles/windows. Manual intervals cap the selected width at 600 buckets. Full range · Auto restores the complete range and automatic buckets. Totals remain for the entire selection.
- **Explorer** opens conversations alongside the session list; it has no aggregation checkboxes. Action counts open tool calls directly. The conversation viewer respects global time/action filters; “Show surrounding conversation” and “Full session time range” let you broaden the detail view.

### Investigating activity

Actions and conversation volume use aligned time axes with independent vertical axes. The default logarithmic view uses `log10(1 + count)` to retain zeros; tick labels and tooltips always show raw counts. Linear scale is available for absolute comparisons. Large volume is not a security verdict.

Hover an action bar for its tool breakdown. Message bars stack user (blue) and assistant (teal) counts, with raw counts on hover. Logarithmic stacks use cumulative boundaries so totals remain correct; segment heights on this scale are not proportional shares. Click a bucket, or choose one in **Inspect**, to reveal contributing sessions. Rank by actions or messages and page through all contributors. Action ranking excludes zero-action sessions. Opening a contributor shows its records within the inspected range; surrounding context and full-session controls remain available.

Historical transcripts can contain many records with nearly identical recorded timestamps. These charts reflect source timestamps; they do not reconstruct original wall-clock timing or infer that clustered records represent live activity.

### Search and action filters

Advanced search scope, matching mode, tool name, and internal-review options live in **More filters**. Search defaults to case-insensitive **whole word / phrase** matching in messages and session titles. For example, `dance` does not match `guidance`. Choose substring matching explicitly when wanted. Tool arguments/output and titles-only are separate searchable scopes. Results include matching excerpts; opening a result shows matching records, including records beyond the first page. “Show surrounding conversation” opens the page around the first matching record.

Search chooses sessions; charts aggregate their activity, not just occurrences of the search term. Connection, date, search, and action filters combine with AND. Action filters narrow sessions to those with matching calls and count only matching calls while retaining their message totals. Action categories (including deletion-related) are text-based hints from tool names and arguments, not safety verdicts; quoted commands may match and indirect commands may be missed.

Codex **guardian approval-review threads** copy parent history. They are identified from transcript provenance and hidden by default; “Include internal reviews” exposes them. Ordinary conversations with no actions remain available. The migration backfills existing records and preserves raw provider payloads and ingestion checkpoints. Separate connections can intentionally contain overlapping source data.

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
  analytics.py    Shared filters, search excerpts, adaptive aggregation
  normalization.py Context and provenance classification, action hints
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

### Shared chart styling

`frontend/src/chartSeries.tsx` provides a fixed 10-color palette, stable categorical assignment, color keys, tooltip rows, and cumulative stacking. Tool assignments persist locally across filters, zooms, and reloads. Nine tool colors plus an overflow **Other tools** color keep the palette bounded; overflow members remain individually listed in the tooltip. Message roles have fixed blue/teal colors. Future charts can reuse the same registry namespace for matching categories.

The sticky scope header includes session-type filtering (all, conversations, or subagents), totals, and an always-present Clear all button. Clear all resets scope filters, selection, and session sorting. Custom date ranges show their dates; full timestamps are available on hover.
