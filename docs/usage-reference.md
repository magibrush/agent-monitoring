# Relay usage reference

Detailed behavior and operational notes. Start with the [README](../README.md) or [setup guide](setup.md) for first-time use.

A local agent monitoring app: React + TypeScript frontend, Python API, and SQLite chat storage.

## What works

- Dashboard with activity charts, prompt/answer counts, and recorded tool-call totals.
- Multiple named connections and independently identified chat sessions.
- Connection, precise time-range, message/tool search, and action-category filters; sorting and pagination.
- Open any Overview session directly in the split-view Explorer; search, filters, and the chart window persist when switching between these views.
- One Overview chart, selected through the Sessions, Messages, or Actions cards, with linear/logarithmic scale and shared time controls in Safety.
- Codex Desktop, Codex CLI, and Claude Code local transcript watchers, with durable checkpoints, pause/resume, source checks, sync errors, and manual sync.
- Local-only HTTP access, SQLite WAL, SQLAlchemy models, Alembic migrations, and tests.

Codex Desktop, Codex CLI, and Claude Code are supported integrations. Pre-tool hooks support blocking evaluation with one Anthropic Haiku judge, deterministic prohibitions, deadline handling, and safety outcomes in the existing charts. See [safety setup and boundaries](rfc-005-blocking-safety.md). Connections without the blocking option retain shadow evaluation. Recorded decisions do not prove execution success or complete protection.

Safety also includes [incident investigations](rfc-007-incidents.md): related concerns and repeated blocks or service failures are grouped into persistent investigations with evidence, notes, and resolution. You can create an incident from action history or attach and detach requests yourself. Resolving an incident never approves an action; live approvals stay at the top of Safety.

## Test security scenarios

For synthetic security scenarios and concurrent load testing, run
`scripts/start-lab.ps1` and open **http://127.0.0.1:8010**. [Relay Lab](../lab/README.md)
is a separate app with isolated databases, the six shared policy presets, scripted
or live judge tests, fault injection, and downloadable results. It never executes
the tool commands being tested.

## Stack choices

| Layer | Choice | Reason |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite | A local dashboard needs client-side interaction; no server rendering requirement |
| Data and charts | TanStack Query, Recharts | Shared query state, polling, filtering, SVG charts |
| UI | Custom CSS, Lucide icons | Restrained light interface, no heavy component framework |
| API | FastAPI, Pydantic | Typed request validation and generated API reference |
| Persistence | SQLite WAL, SQLAlchemy 2, Alembic | Simple local setup, durable identity, controlled schema changes |
| Later | PostgreSQL + transactional outbox | Multiple workers/hosts and stronger concurrent ingestion |

The SQLite database lives at `data/monitor.db`. It contains private chat text, raw provider records, and safety evaluations in plaintext. Fill `.secrets/anthropic.key` to enable Haiku workers; new pre-tool action arguments and bounded preceding context are sent to Anthropic after limited redaction. Without a key, jobs wait locally. Bind to loopback only; this is a single-user local app, not a secured multi-user deployment.

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

That launcher also starts two parallel safety evaluation threads in a separate worker process. If you start Uvicorn manually, run `scripts/start-worker.ps1` separately. Put your API key alone in the ignored `.secrets/anthropic.key` file; workers notice it without restarting. Open **Safety → Settings → Protection by connection → Configure → Enable blocking Haiku evaluation**, then restart agent sessions and trust the Codex handler if prompted. Covered actions wait up to 60 seconds; an allow verdict or your approval continues to native permissions. Review requests appear in **Safety > Needs your decision** with **Approve** and **Deny** controls. The 60-second deadline includes human review; expired calls need a new request. See [human review](human-review.md). The **Safety** workspace puts live approval cards first, followed by a compact action history. Select an outcome chip or chart bar to filter history; click an action to see its verdict and evidence. History filters do not hide live approvals. Judge setup and protection modes are in Settings. See [RFC 005](rfc-005-blocking-safety.md).

For frontend development, run the same Python service plus `npm run dev` in `frontend`, then open **http://127.0.0.1:5173**. Vite proxies `/api` to port 8000. API reference: **http://127.0.0.1:8000/docs**.

If the system Node is old, use a newer Node in PATH. Codex installations may provide a compatible bundled Node under `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`. `scripts/start.ps1` can use that runtime automatically after dependencies are installed.

### Add Codex Desktop or CLI

1. Click **Add connection** and choose **Codex Desktop** or **Codex CLI**.
2. Relay detects the normal local profile and shows how many conversations it found.
3. Click **Connect**. Already-connected sources are marked and cannot be added twice.

No folder or name is required for normal setup. Open **Another profile or archived conversations** only for a custom local profile, an accessible WSL folder, or archives. Archives are a separate connection, not included in the normal source. Optional names distinguish multiple profiles of the same app. Missing folders and malformed metadata are reported before connecting.

A connection is an app plus a local transcript folder, not a terminal window, project, or login. Normally there are two active sources (Codex Desktop and Codex CLI) sharing one profile, with an optional archive source for each. There is no fixed maximum of four: additional CODEX_HOME profiles and accessible folders can have their own connections. Opening several terminals or projects does not require extra connections. Source creation provenance determines routing when a session is resumed elsewhere.

### How CLI sessions map to connections

- One connection watches sessions across projects and terminals. Different project folders do not require separate connections.
- The suggested path comes from Relay's `CODEX_HOME`, or `~/.codex`. A CLI with a different `CODEX_HOME` needs a connection pointing at that profile's `sessions` directory. WSL requires an explicit path readable by the Windows backend; remote hosts are not discovered.
- Desktop keeps the existing `codex` provider ID; CLI uses `codex_cli`. Existing Desktop IDs, history, and checkpoints remain compatible without a schema migration.
- Classification uses initial `session_meta`: Desktop originator `Codex Desktop`; explicit `cli`/`exec` source regardless of client label, or recognized `codex_cli_rs` / `codex-tui` originators with subagent/omitted source. Desktop originator takes precedence. Unsupported combinations remain unclassified.
- Session identity is `(connection, Codex session ID)`. Resuming continues the existing entry. Switching clients does not move a transcript between connections: creation provenance determines ownership. Subagents remain separate sessions; internal reviews stay hidden by default.
- Duplicate directories for the same integration are rejected. Distinct connections, including overlapping directories or copied profiles, have separate identities and can count overlapping history. Prefer non-overlapping directories per integration.
- Monitoring is read-only; no hooks or model calls are needed. Only flushed transcript records are visible.

For a manual check, add a CLI connection, run a **new** `codex` session in any project, exchange messages and run a harmless tool, then inspect Overview and Explorer. Resume it and verify the same row gains activity. Pause the connection, add activity, and resume to verify catch-up. A Desktop connection sharing the path should not acquire the new CLI session.

Browser tests can use another port without stopping the app: set `$env:RELAY_E2E_PORT = "18000"` before running `npm run test:e2e`. They still use the isolated `data/e2e.db`.

### Connection identity and removal

Desktop connections use a teal monitor tile labeled **Codex Desktop**; CLI connections use a purple terminal tile labeled **Codex CLI**. Connection names remain visible in session lists, Explorer, and mobile layouts so profiles of the same integration can be distinguished.

Use **Connections → Delete** to remove a connection. The confirmation removes that connection's imported sessions, events, and checkpoints from Relay in one transaction. Original transcript files and other connections are untouched. Reconnecting the same source imports its available history again. This removes database records; it is not a secure-erasure operation on SQLite files or backups.

### Metric definitions

“Questions” means user prompt messages, including requests without question marks. “Answers” means assistant messages, including commentary. Injected setup context is excluded from these counts and preserved for inspection. “Actions” means recognized tool-call records, excluding tool outputs; these records do not prove an action succeeded. Session count means sessions with observed events in the selected range. Session list last activity is lifetime activity; message and action counts follow the selected window.

### Time, selection, and exploration

- **Fit activity** uses the actual event timestamps of matching/selected sessions. Automatic buckets target roughly 100 points, from one minute through one year. Empty buckets show zero activity. Thirty-day and year buckets are fixed durations, not calendar month/year boundaries. Data is stored in UTC; dates and chart labels display in your browser timezone.
- The **time-range picker** offers recent presets and precise custom start/end dates and times. The end is exclusive. A range filters sessions to those with activity in it, then limits their counts and conversation records. Presets capture a fixed window at the moment you select them.
- **Overview time controls** work together. Dragging, zooming, panning, and navigator changes synchronize the date picker, totals, and session list with the chart window. Explicit resolution is honored: ranges exceeding 600 buckets show a paged window at that resolution. The compact navigator always shows the full filtered timeline; drag its handles to resize or its middle to pan, with updates on release. Arrow keys move focused handles/windows. Manual intervals cap the selected width at 600 buckets. Full range · Auto restores the complete range and automatic buckets. Reset restores the broader date filter; Clear all removes all filters.
- **Explorer** opens conversations alongside the session list; it has no aggregation checkboxes. Action counts open tool calls directly. The conversation viewer keeps the selected time range and hides setup context. “Show surrounding conversation” broadens message/tool matching within that range.

### Investigating activity

Actions and conversation volume use aligned time axes with independent vertical axes. The optional logarithmic view uses `log10(1 + count)` to retain zeros; tick labels and tooltips always show raw counts. Linear scale is available for absolute comparisons. Large volume is not a security verdict.

Hover an action bar for its tool breakdown. Message bars stack user (blue) and assistant (teal) counts, with raw counts on hover. Logarithmic stacks use cumulative boundaries so totals remain correct; segment heights on this scale are not proportional shares. Click a bar to populate the permanent inspector beside the chart, or focus the chart and use arrow keys. Actions shows action counts, Sessions lists sessions, and Messages shows user/assistant counts and conversations. Dragging updates the inspector to the selected window. Opening a contributor shows its records within the inspected range; surrounding context and full-session controls remain available.

Historical transcripts can contain many records with nearly identical recorded timestamps. These charts reflect source timestamps; they do not reconstruct original wall-clock timing or infer that clustered records represent live activity.

### Search and action filters

Advanced search scope, matching mode, tool name, and internal-review options live in **More filters**. Search defaults to case-insensitive **whole word / phrase** matching in messages and session titles. For example, `dance` does not match `guidance`. Choose substring matching explicitly when wanted. Tool arguments/output and titles-only are separate searchable scopes. Results include matching excerpts; opening a result shows matching records, including records beyond the first page. “Show surrounding conversation” opens the page around the first matching record.

Search chooses sessions; charts aggregate their activity, not just occurrences of the search term. Connection, date, search, and action filters combine with AND. Action filters narrow sessions to those with matching calls and count only matching calls while retaining their message totals. Action categories (including deletion-related) are text-based hints from tool names and arguments, not safety verdicts; quoted commands may match and indirect commands may be missed.

Codex **guardian approval-review threads** copy parent history. They are identified from transcript provenance and hidden by default; “Include internal reviews” exposes them. Ordinary conversations with no actions remain available. The migration backfills existing records and preserves raw provider payloads and ingestion checkpoints. Separate connections can intentionally contain overlapping source data.

## Verify

Transcript rewrites and truncations recover automatically. Relay replays current records without duplicating unchanged observations, retains previously imported history, and continues collecting new activity. No manual repair is needed; rewrite diagnostics appear only in debug logs. See [automatic transcript replay](transcript-recovery.md).

### Optional live hook observations

Open **Connections → Set up live hooks → Enable live hooks** for a normal profile.
Relay adds an observer to the profile settings while preserving existing hooks and
saving a backup. Restart Claude/Codex sessions; review and trust the Codex observer
in `/hooks`. The connection shows **waiting for first hook** until a notification
actually arrives. Run a harmless tool and check **Last received**, then inspect the
action in Explorer for its hook/transcript source and observed outcome.

By default the observer only queues local notifications and exits without a decision.
The optional blocking gate holds covered actions for Haiku and denies on policy rejection or evaluation failure. Queued observations survive downtime;
the dashboard refreshes every two seconds. Exact tool-call IDs prevent duplicate
action counts when transcripts catch up. Unknown results stay unknown.

Use **Disable live hooks** to remove Relay's handlers. Pause queues notifications
for catch-up. Disable before deleting a connection to remove its provider settings
too; deletion alone deactivates capture and leaves inert handlers. Both queue data
and provider-settings backups are local plaintext. See [RFC 003](rfc-003-live-hook-observation.md)
for coverage, limits and validation. Existing transcript-only monitoring still works.

```powershell
uv run pytest -q
cd frontend
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser test config starts a separate backend on port 8000 with an isolated `data/e2e.db`. Stop the normal server first. Browser tests require a frontend build and the `.venv` created by `uv sync`; tests reset only their isolated database. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can optionally point to an already installed compatible Chromium executable.

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

Claude Desktop export importing has been removed. Any previously imported records remain in the local database, but are excluded from all monitoring views and cannot be accessed through the API. Database files and local transcripts are never tracked in Git. Claude Code is supported through its separate local transcript adapter.

### Shared chart styling

Click an Overview metric card to switch the single chart while retaining its time window and interval. Session bars count distinct sessions with activity in each bucket; the same session can appear in several buckets. Overview and Safety share drag-to-zoom, a full-range navigator, exact intervals, pan, and reset. Safety history follows the visible window or selected bar; live approval requests remain visible across all connections. Tooltips use colored keys with neutral text in both views.

Action charts rank tools independently inside each time bar. Ten predefined colors mean ranks 1 through 10, with gray combining additional actions in that bar. Ties use action name. There is no global action legend because a color can represent different tools in different bars. Linear scale is the default; logarithmic mode warns that segment heights are not proportional shares. Hover or select a bar for its action names, ranks, exact counts and percentages. Window inspection shows neutral aggregate totals; select a bar for matching rank colors. Message roles retain fixed blue/teal colors.

The sticky scope header includes session-type filtering (all, conversations, or subagents), totals, and an always-present Clear all button. Clear all resets scope filters, selection, and session sorting. Custom date ranges show their dates; full timestamps are available on hover.

### CLI discovery and troubleshooting

On Windows, default CLI transcripts live in `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`. `CODEX_HOME` overrides the `.codex` home. Archived sessions live in its `archived_sessions` sibling. Project directories are recorded inside transcripts rather than determining their storage location.

Relay checks its configured `CODEX_HOME`, the standard user home, archive folders, and existing connection paths. It does not scan the whole disk or infer environment variables belonging to another terminal. Custom profiles, WSL, and remote hosts require an accessible path. Discovery reads metadata only; adding a connection imports recorded history.

Connection cards show imported session counts and offer **Check source**. Zero matching CLI sessions with Desktop sessions present means a source mismatch; unsupported counts indicate unrecognized provenance. A missing directory or malformed header produces an explicit error. A folder can be connected before its first session exists.

A development check with Codex CLI 0.154.0 observed `originator: "codex-tui"`, `source: "cli"`. The older originator-only check incorrectly skipped those files. The corrected parser was validated read-only against two actual conversations (12 messages, 16 calls, 16 results, 2 context records) and a repeat scan produced no duplicates.

### Conversation composition in charts

Choose **Color by → Conversation** to see which conversations make up each action/message bar. This mode uses a linear scale so colored segments represent true counts and shares. Each bar ranks its ten most active conversations independently, combining the remainder as **Other conversations**. Colors represent ranks, with names and counts shown when hovering or inspecting that bar. Safety outcome coloring follows the same per-bar ranking; neither mode has a full-range color legend.

Click a bar to populate the inspector for the active chart. Session and message entries open the conversation; action entries show counts. Each entry opens that conversation in the selected time range. Switching back to **Activity type** restores tool/role breakdown and the previous scale. Conversation colors remain selected when filters change.


### Add Claude Code

Choose **Add connection > Claude Code > Connect**. Relay detects `~/.claude/projects` or `CLAUDE_CONFIG_DIR/projects`, with a folder override under **Another profile or folder**. Point it at the projects directory (all projects), a single project folder, or an accessible WSL/profile directory. Claude Code does not use the Codex archive toggle.

The separate `claude_code` integration reads user text, assistant text, tool requests and results from complete JSONL records. Each content block is retained in order; thought blocks and binary attachments are not rendered. Stable record UUIDs prevent duplicates on resume/replay. Nested `subagents/agent-*.jsonl` files have separate identities linked to the parent session, even when they share its sessionId. Errors appear on the connection; malformed batches roll back with their checkpoints. Source files are never changed.

Claude Code uses an amber **Claude Code** badge. Search, action filters, charts and Explorer share the same event model as Codex. Read/Glob/Grep map to reads; Write/Edit/MultiEdit/NotebookEdit to file writes; Bash/PowerShell to shell; WebFetch/WebSearch to network. Existing deletion heuristics still apply to shell commands. Recorded requests do not imply successful execution. Retired `claude` Desktop imports remain hidden and cannot be enabled through this adapter.

Transcript layout references: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions). This is polling-based observation; no hooks need installing.

### Token usage

Session lists show provider-reported input and output tokens within the selected time range. Input includes cached tokens; Codex cached input is already included in its input total, while Claude cache reads and writes are added to its uncached input. Output includes reported reasoning usage where the provider includes it. Counts are usage across requests, not unique words or the current context size. Missing breakdowns show —; ≥ marks a partial reported total. Usage records do not add messages or actions.

In Sessions, choose **Color by → Tokens · input / output** to plot input and output tokens over time. The axis measures tokens in this mode. Codex cumulative counters are converted into increments, and repeated Claude message IDs are counted once. Existing transcripts are reread once on upgrade to backfill usage. No API calls or token estimates are needed.

### Safety notifications and review

In **Safety**, choose **Enable notifications** and allow the browser permission. Keep a Relay tab open to receive new alerts; browser suspension or operating-system notification settings can delay them. Alerts contain the tool, session, reason and expiry time. Supported browsers show **Approve** and **Deny** actions, using the same deadline and assessed-input checks as the app. Clicking the notification focuses an existing Relay tab at the review, or opens Relay at its current origin if no tab remains. Notification appearance and action support depend on the browser and OS. Safety settings let you turn alerts off.

The live queue covers all connections, independently of history filters. Outcome cards filter the timeline and action list; click an action for its command, judge recommendation, human decision and execution status in the adjacent inspector. Technical details remain available within that inspector. A pending-review badge is visible while using other workspace views.

### Safety performance and deadlines

To test routing, open **Safety → Settings → Debug**, enable **Debug mode**, and choose **Review**, **Allow**, or **Deny**. Debug is disabled by default; Review is the initial selection. Changes persist and apply to new assessments on all connections. Debug substitutes a local result for the judge without calling Anthropic. To test approval, use a connection with blocking evaluation enabled and issue a new harmless action. Shadow assessments remain advisory. Existing assessments retain their original configuration.

Simulated decisions are marked **Debug** and excluded from production performance summaries. Hard-rule denials, incomplete-action safeguards, deadlines, and human approval checks remain enforced. Turn Debug mode off to resume normal judging.

[RFC 006](rfc-006-safety-performance.md) describes the architecture and remaining milestones. Migration `0010` adds stage timestamps and per-attempt duration/usage. **Safety → Settings → Performance** shows the last 24 hours of automatic pause p95, failures, expiries and missing receipts. **Action → Technical details** shows intake, queue, all model attempts, human response, publication, delivery and total pause. Missing historical timestamps show `—`. `/api/safety` additionally exposes p50/p95/p99 by automatic path and aggregate blocked-agent time. Samples are bounded to the latest 10,000 blocking requests and truncation is explicit. Pause starts at gate-wrapper entry; provider scheduling and interpreter startup before that point cannot be measured by the wrapper.

The original 60-second deadline stays fixed. Automated evaluation ends 32 seconds before it, reserving 30 seconds for a human plus a two-second delivery margin. Blocking judge attempts have a supervised 10-second wall-clock limit, at most two attempts, and no retry unless enough time remains. Budget exhaustion, provider failure and overload block visibly; none defaults to allow. A crashed blocking lease can be reclaimed within roughly 12 seconds, only if budget remains. Old results cannot authorize the action.

With the default two workers, one lane is reserved for blocking calls and one handles both blocking and shadow work. One-worker mode is blocking-only; use at least two to process shadow work. The 1,000-job admission ceiling reserves 100 slots for blocking work, and each connection can have at most 20 queued/running/awaiting-review blocking requests. These are process-local worker reservations and local admission limits, not distributed API quota enforcement. Hook ingestion has a separate application lock; transcript writes commit in batches of 100 records in production. SQLite still permits one writer, so storage contention remains possible.

Run `.venv/Scripts/python.exe scripts/evaluate_safety.py` for the offline synthetic policy baseline. Add `--live` to evaluate the 12 built-in synthetic cases with Haiku (paid API calls); this sends no historical user conversations and executes none of the described commands. Offline routing does not establish model accuracy. Live results include expected/actual verdicts, timing, usage and a confusion summary. The five-second p95 goal is not a measured production guarantee.

### Safety policies

Open **Safety → Policies** to define rules for files, shell commands, detected Git pushes, sensitive-file access, network requests or an exact tool. Rules can cover all or selected connections and choose **Block**, **Ask me**, **Send to judge**, or scoped file-read **Approve automatically**. **Save rule → optionally simulate → Apply changes** keeps editing separate from enforcement. Optional live testing records proposed decisions without changing current behavior. Edits accumulate in one draft. History shows applied changes and restores them into a draft. See [the policy guide](policies.md) for supported conditions and limitations.

Implementation checkpoint: [20 September 2026 progress and verification](progress-2026-09-20.md).
