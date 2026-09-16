# Relay — progress

Updated: 16 September 2026

## Goal

Build a local app for observing multiple LLM agent sessions, then extend it with fast, reliable action validation and prevention, worker monitoring, and stress testing.

## Implemented

- **Stack:** React + TypeScript + Vite, TanStack Query, Recharts, and custom CSS; Python FastAPI backend; SQLite in WAL mode with SQLAlchemy and Alembic migrations. SQLite supports the current single-user setup; PostgreSQL and a transactional outbox are the planned direction for concurrent workers and multiple hosts.
- **Codex Desktop ingestion:** multiple named connections, read-only local transcript polling, durable checkpoints, pause/resume, manual sync, and error reporting. Sessions, messages, tool calls, and provider records are stored locally.
- **Monitoring:** aggregate selected sessions, inspect conversations and tool records, search with matching excerpts, and filter by connection, time, action category, tool, or session type, including subagents.
- **Visualizations:** aligned action/message charts, stacked breakdowns, adaptive or explicit time buckets, custom ranges, zoom/pan, a range navigator, linear/log scales, and session drill-down. Shared colors and tooltip components support future charts.
- **UI and data cleanup:** compact sticky filters and totals, a stable Clear all button, and a separate conversation Explorer. Internal approval-review copies and injected setup context no longer inflate default monitoring; search defaults to whole-word/phrase matching. Fixed the oversized shell-action badge caused by a CSS class collision.

## Scope decisions and limits

- Claude Desktop support was removed after investigating its integration constraints. Claude Code hooks and other CLI integrations remain future work.
- Current ingestion observes recorded activity after it happens; it cannot block actions. Tool-call records do not prove success, and action categories are search hints, not security verdicts.
- The app is local and single-user, with one backend process. Transcript compatibility depends on the provider format. Logarithmic chart alternatives were reviewed but remain a future design decision.

## Next phases

1. Add integrations with pre-execution hooks or controlled tool gateways, distinguishing observation from enforcement.
2. Design Python validation workers with fast rules, optional LLM judgment, explicit timeout/failure behavior, and worker performance metrics.
3. Add suspicious-activity review and enforcement outcomes to the dashboard.
4. Build a separate load simulator to test throughput, latency, backpressure, and recovery; consider SIEM export later.

## Validation and references

### Codex CLI monitoring — 16 September 2026

- Generalized connection discovery, adapter dispatch, API access, and analytics through a supported-provider registry. Existing Desktop records remain compatible without a schema migration.
- Added Codex CLI connections, creation-provenance routing, source checks, and shared checkpointed JSONL reading. Desktop and CLI can share a directory; sessions across profiles retain connection-scoped identities.
- Added integration selection and labels throughout connection setup and monitoring. Claude Code and enforcement remain future work.
- Validation: 27 backend tests, the existing browser workflow/palette checks, the new CLI browser workflow, and production build passed. CLI tests cover mixed sources, replay, partial writes, resumes, subagents, pause/catch-up, and profile separation. Actual local transcripts available for inspection were Desktop-created; live CLI compatibility awaits manual testing.

The monitoring/UI milestone passed 12 backend tests, browser/palette checks, and a production build. The subsequent badge fix also passed the build.

See [ingestion and enforcement research](ingestion-and-enforcement.md), [UX review](ux-review.md), and the [README](../README.md) for implementation details and setup.

### CLI compatibility fix and easier setup

The initial CLI implementation rejected real Codex 0.154.0 `codex-tui` provenance. Classification now prefers explicit CLI/exec source after Desktop provenance and supports both known CLI originators. Read-only validation against two real CLI transcripts imported 46 records with no duplicates on replay.

Setup now discovers known folders, recommends a source with matching sessions, checks paths automatically, accepts a Codex home directory, and reports source counts. Existing connection cards show imported session counts and source diagnostics. Validation: 31 backend tests, all three browser checks, and production build passed.

### Connection identity and deletion

Desktop and CLI now use distinct monitor/terminal tiles with explicit labels and high-contrast colors. Connection names are more legible and stay visible on mobile and in Explorer. Connection deletion removes the connection, sessions, events, and checkpoints transactionally while preserving source files and other connections. Cancel, re-import, filter cleanup, and mobile layouts are browser-tested.

An independent UI/UX reviewer examined the implementation and desktop/mobile screenshots; all four findings were addressed (Escape handling, dialog spacing, mobile/Explorer name size, and deletion target contrast). Validation: 32 backend tests, three browser tests, and production build passed.

### Simplified setup and conversation composition

Product badges now explicitly read Codex Desktop / Codex CLI. Setup is product cards, automatic count, and Connect; folder/name/archive settings are collapsed. Existing source combinations show Already connected. Archives stay separate; multiple local profiles remain supported.

Charts offer Color by Conversation with linear stacks, eight named sessions plus Other, matched legends, exact counts, and inspector share tracks. Grouping is bounded in SQL and fixed across the selected scope during zoom. Viewport endpoint semantics now match the inspector. An independent UX reviewer planned and reviewed setup and desktop/mobile chart screenshots; all actionable findings were addressed. Backend validation: 35 tests.


## Claude Code integration (16 September 2026)

Implemented separate claude_code adapter with project discovery, config directory override, per-block events, UUID replay deduplication, tool-result correlation, partial-line retry, transaction rollback, and distinct subagent identities. Shared setup filters detected sources by adapter and uses Claude-specific diagnostics and badge; archive option remains Codex-only. Existing search, charts, action filters and Explorer use the common model. Explicit Claude tool mappings added. Retired claude imports remain inaccessible.

Validation: 46 backend tests and 5 browser tests passed; TypeScript and production build passed. Read-only real history validation in an in-memory database found 40 main sessions, 44 subagents and 12,686 events, with zero new events on replay. Source transcripts were not changed. Port 8001 restarted; live config exposes all three integrations and detects local Claude transcripts.


## Action palette and tooltip correction

Replaced first-seen persistent color allocation with dynamically count-ranked top ten tools across the current filtered range. Ten distinct palette slots plus neutral Other preserve counts and remain fixed during zoom. Fixed message role colors remain independent. Tooltips now render in a body portal, use measured viewport clamping, truncate long preview labels, and shorten on compact screens. Inspect exposes searchable ten-row pages of all action types. UI/UX reviewer checked desktop/mobile screenshots with 100 unique actions; review fixes applied for swatch spacing and bucket-specific Other counts. TypeScript/build and all six browser tests passed; port 8001 serves the updated assets.
