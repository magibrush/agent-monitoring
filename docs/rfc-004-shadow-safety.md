# RFC 004: Shadow safety evaluation and local rules gate

> Anthropic is the default and recommended judge provider. OpenAI is also available for judgments and incident analysis, but has not been tested with live API calls. See [OpenAI setup](live-safety.md#optional-openai-credentials-untested). Anthropic-specific details below describe the default configuration.

> Historical design record. Setup, UI, and timing details may have changed. See [current setup](setup.md), [architecture](architecture.md), and [usage](usage-reference.md). Test results below belong to this milestone.

Historical milestone. [RFC 005](rfc-005-blocking-safety.md) supersedes the gate behavior with blocking Haiku evaluation and chart integration.

Status: Implemented, 17 September 2026. Real Anthropic evaluation awaits a user-supplied API key. Automated API tests use synthetic responses.

## Start

Put the Anthropic API key alone in `.secrets/anthropic.key` (no quotes or variable assignment). This directory is ignored by Git. Startup creates an empty file if missing and never overwrites one. `ANTHROPIC_API_KEY` takes precedence; `RELAY_ANTHROPIC_KEY_FILE` selects a different file. Keys are read on every worker iteration, never returned through the API or included in evaluator errors. The file is local plaintext; its permissions follow the user's directory permissions.

Run `scripts/start.ps1` on Windows or `bash scripts/start.sh` on Linux to install dependencies, migrate, build, and launch the API and a separate worker process with two evaluation threads. Ctrl+C stops that worker; unfinished leases recover on the next launch. For a manually launched server, first run `uv run --locked alembic upgrade head`, then run `scripts/start-worker.ps1` (Windows) or `bash scripts/start-worker.sh` (Linux) in another terminal. The API still requires a single Uvicorn process because transcript/hook collection uses its existing process-local lock. The worker CLI is `python -m backend.safety_worker --workers 2` (1–8). Multiple worker processes can safely compete for jobs, but concurrency must remain within API quotas.

Connections displays key presence, worker heartbeat, queue counts, oldest pending intake, and unevaluated counts. Explorer displays each shadow verdict, reasons, rule findings, missing context, attempts, model/policy, latency, token usage and the assessed context. Key presence is not proof of valid API credentials. Worker presence is not proof of complete hook coverage.

## Flow

1. The existing observer atomically spools local hook envelopes. Existing installed observers do not need reinstalling for shadow evaluation.
2. The collector associates the hook with a session and action. A new `PreToolUse` observation creates an evaluation in the same database transaction as ingestion. Transcripts and post-hooks alone do not trigger model calls; historical events are not backfilled.
3. A SHA-256 hash of exact tool name/input/cwd plus canonical event ID deduplicates evaluations. Different arguments for a reused call ID create separate evaluations. Context is frozen at intake.
4. Deterministic prohibitions produce a completed shadow denial without a model call. Every other accepted pre-hook queues one Haiku evaluation; there is no cheap model or escalation tier.
5. A separate worker atomically claims a job with a unique lease token. Network work holds no DB transaction or ingestion lock. Haiku returns a forced `submit_verdict` tool response that is validated as data and never executed.
6. Completion requires a matching, unexpired lease. Expired workers cannot replace a newer or final decision. Deleting a connection removes its jobs; an in-flight result cannot recreate them. Already transmitted API requests cannot be recalled.

The API calls `https://api.anthropic.com/v1/messages` with pinned model `claude-haiku-4-5-20251001`, a 1,200 output-token ceiling, and 25-second socket timeout. HTTP redirects are refused. Model results are advisory `allow`, `review`, or `deny`, with risk, reason, evidence, and missing-context fields. An incomplete action snapshot cannot receive an accepted allow recommendation. Model judgments are fallible and are never treated as execution outcomes or user approvals.

## Data and reliability

SQLite WAL remains the local durable job store for this milestone. Atomic conditional updates, rather than Python locks, protect job claims across processes. This is at-least-once evaluation: a crash after an API response but before commit may incur a second API call. It is not exactly-once billing. Lease duration is 120 seconds; crashed jobs become eligible again when a keyed worker polls. Network/429/server/invalid-response failures retry with 30/60-second delays, at most three attempts. Authentication and other permanent HTTP failures remain failed for inspection. Pending jobs older than 24 hours fail rather than silently sending stale work. With no key, attempts are not consumed. Worker heartbeat expires after 30 seconds.

At most 1,000 queued/running evaluations are admitted by the single collector. Overflow records stay visible as skipped, not safe. These bounds cap pending work, not total database retention or daily API spending. There is no autoscaler, global rate limiter, approval queue, or automated replay of failed jobs yet.

The assessed evidence contains up to 24,000 characters of action JSON and eight preceding records of up to 1,500 characters each. Evidence can be incomplete because transcript ingestion lags a hook. It is never represented as verified authorization. The worker sends this evidence to Anthropic. Limited redaction masks Anthropic keys, private-key blocks and some named secrets; this is not comprehensive DLP. Original hook/transcript payloads remain local plaintext under existing retention behavior. Returned reasoning and evidence are stored locally. No raw HTTP error body or authentication header is persisted.

## Opt-in gate

Connections → Set up live hooks → Enable deterministic rules gate → Save/Enable. This replaces only Relay's pre-hook observer for that connection with `scripts/gate_hook.py`; post-hook observation stays in place, other handlers are preserved, and provider settings are backed up. Restart provider sessions and review/trust Codex handlers as required. Merely receiving an observation does not prove runtime enforcement compatibility.

The gate runs a local stdlib-only rules check before returning. It has no API/worker dependency. A pass prints nothing and exits 0, retaining normal provider permission checks. A denial prints a fixed reason to stderr and exits 2. Malformed/oversized input, policy errors and spool failures deny. The provider timeout is 10 seconds; hook launch failures, outer timeouts, disabled handlers and bypasses are outside the guarantee.

Version `relay-v1` narrowly denies:

- Direct `Read`/`read_file`/`Write`/`write_file`/`Edit`/`edit_file`/`MultiEdit` access to the user's `.ssh`, `.aws`, or Relay `.secrets` directory.
- Direct file modification through those tools of Relay `backend`/`scripts` files or the standard/configured Codex hooks and Claude settings files.
- Exact standalone `rm -rf /`, `rm -fr /`, and corresponding `sudo` or `/*` forms.

The installed gate checks the transcript root and Codex creation provenance before applying rules, separating Desktop and CLI handlers in a shared profile. Missing/unreadable in-scope Codex identity denies rather than guessing. Like the collector, this routing relies on local transcript data and is not an independent authentication boundary.

Relative file paths require an absolute hook cwd to resolve confidently. Unknown scope and arbitrary shell programs are shadow-review signals, not deterministic denials. Regex is only a narrow signal; commands, scripts, symlinks changed after a check, subprocesses, alternate tools, persistent shells and hosted tools can escape coverage. Custom profile paths not reflected in the gate's environment are not necessarily protected. The agent's OS account can still modify this installation; this is not a tamper-resistant sandbox.

Gate reports are displayed as **Gate returned pass/deny**, separately from observed execution results. Pausing a connection delays ingestion but leaves its installed gate active. Disabling hooks or deleting the connection deactivates its gate markers; disabling hooks also removes Relay's provider handlers. A session that has not restarted can retain an older handler. Shadow verdicts never change a completed gate decision.

## Validation

Backend tests exercise atomic ingestion/deduplication, rollback, changed arguments, parallel claims and evaluations, lease recovery, stale-result fencing, missing-key recovery, retries, expiration, overflow, redaction, response validation, HTTP error sanitization, gate subprocess return behavior, settings preview/install and deletion with an active job. Browser tests cover queue/verdict presentation, gate configuration and mobile layout. All gate tests use synthetic payloads and do not execute the described command.

Validation completed: 76 backend tests, all 9 browser tests, TypeScript and production build passed. The 2 affected browser flows passed again after shared-profile routing was added. Desktop/mobile screenshots were visually checked. Migration upgrade/downgrade/upgrade passed against an isolated database. The local database was backed up to `data/monitor.before-safety-20260917-000636.db` and migrated to 0005. Relay was restarted on port 8001 with a separate two-thread worker; health and heartbeat were verified, one new live hook queued, key absent, and all three existing gates disabled. No paid model request or real provider enforcement smoke test was performed.

References: [Anthropic API primer](https://platform.claude.com/docs/en/claude_api_primer), [Claude hook reference](https://code.claude.com/docs/en/hooks). Provider-specific real enforcement compatibility remains to be tested before relying on the gate.
