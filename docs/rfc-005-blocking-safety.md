# RFC 005: Blocking Haiku evaluation and safety visualization

> Anthropic is the default and recommended judge provider. OpenAI is also available for judgments and incident analysis, but has not been tested with live API calls. See [OpenAI setup](live-safety.md#optional-openai-credentials-untested). Anthropic-specific details below describe the default configuration.

> Historical design record. Setup, UI, and timing details may have changed. See [current setup](setup.md), [architecture](architecture.md), and [usage](usage-reference.md). Test results below belong to this milestone.

Implemented 18 September 2026. Supersedes RFC 004's advisory-only gate design.

Updated 19 September: [human review](human-review.md) adds a distinct awaiting
approval state and Approve/Deny controls in Safety. The original deadline still
applies; review no longer becomes an immediate denial.

## Operation

Enable **Connections → Set up live hooks → Enable blocking judge evaluation**.
Restart agent sessions; review/trust Codex handlers in `/hooks` when required.
Connections without this option retain shadow evaluation. Existing sessions may
retain an old observer until restarted; a configured gate is not evidence that an
agent has loaded it. Gates apply only to covered pre-tool calls. Built-in native
permissions still apply after Relay releases a request.

The command hook routes the request to the correct profile/creation provenance,
checks deterministic prohibitions, then atomically spools a unique request with
the exact action hash and a 60-second deadline. It remains running while waiting
for a matching response. Provider hook timeout is 75 seconds, allowing the wrapper
to return a denial first. A pass emits no permission override and exits zero.
A deny, unresolved review, malformed/mismatched response, recording error or
timeout exits 2. Local rule prohibitions return immediately without a model call.

The collector persists request, frozen context and job in one transaction. Two
worker threads evaluate requests concurrently using Haiku 4.5. Blocking jobs are
claimed before shadow work. A 25-second socket timeout and at most two attempts
apply to blocking evaluation; a retry requires at least 28 seconds remaining.
The hook's monotonic clock independently prevents late release even if a network
call, database transaction, collector or worker runs beyond the deadline.

Committed decisions are atomically published in a per-connection `replies` folder.
The hook verifies request ID, exact action hash and deadline before accepting one.
It records a receipt before returning. This receipt describes the wrapper's
release/deny intent, not proof of native tool execution. A worker's expired lease
cannot alter a final result. A late evaluation cannot revive an expired request.
Missing service, worker or API key results in a denial at the deadline. Pausing
transcript collection keeps blocking hook collection and decision delivery active.
Disabling hooks deactivates future stale handlers; already-waiting requests retain
their deadline. Configuration changes require a session restart.

## Judge contract and context

The pinned judge remains `claude-haiku-4-5-20251001`. There is one model, not a
cascade. Strict tool output (`strict: true`) constrains the verdict schema. Since
Anthropic does not accept length constraints in that schema, the wire schema
omits them, the prompt requests concise output, and Pydantic still enforces local
limits. Invalid output never defaults to allow. Truncated actions cannot receive
an accepted allow recommendation.

A user-approved replay of one historical failure reproduced `list_type` errors
for `evidence` and `missing_context`: the old non-strict response supplied values
that were not arrays. Earlier records did not retain validation diagnostics, so
this does not establish the exact content of every historical failed response.
New errors retain field names, error types, stop reason, response ID and usage;
raw response/error bodies and keys are not logged. Every worker attempt has its
own audit record. Old failures are preserved.

Evidence includes the original bounded action/context, three recent recorded user
requests, and bounded fresh messages from the already validated transcript's last
256 KiB. Live context mitigates transcript collector lag and tool-heavy histories.
User-role messages indicate task intent, not independently authenticated authority;
embedded third-party instructions remain untrusted. Policy distinguishes opening
an editor for user input from extracting or transmitting credentials and forbids
the judge from inventing hard prohibitions. Limited secret redaction is not DLP.

**Review again in shadow mode** creates a new retrospective assessment with the
old evidence, preserving prior attempts and never releasing the old action.
Charts retain the latest blocking request's control outcome even if a later shadow
review is created. Explorer retains all assessments.

## Visualization

Overview → **Color by → Safety outcome** uses the existing action chart, time
window, zoom, connection/session/type/search/action filters and selected sessions.
Each action is counted once as pending, released, denied, evaluation failed,
shadow assessed or not assessed. Risk flags (`review`, `deny`, or high risk) are
counted independently. The chart shows current safety state grouped at the action's
request time, not a reconstructed historical state at each instant.

Scope totals include the full selected range; bars and the inspector respect the
visible window or clicked bucket. The inspector filters outcome and flagged risk
and opens per-action reasons, rules, diagnostics and context. The action timeline
shows requested, evaluation started, decision and hook receipt, while observed
execution remains separate. Worker counts in Connections are explicitly global.
Old transcript-only actions are **Not assessed**, not implicitly allowed.

## Persistence, upgrade and boundaries

Migration 0007 extends evaluations with a request identity, control lifecycle and
diagnostics, and adds `safety_attempts`. Old rows remain shadow records. Back up
before migrating. An automatic downgrade is refused because multiple requests per
action cannot fit the old uniqueness constraint without dropping audit records;
restore the backup to revert. Collector/API remains a single process; workers are
separate and claims are atomic across processes. At-least-once evaluation can
incur duplicate API billing after a crash.

This is a local cooperative gate, not a tamper-resistant executor or sandbox.
An agent with the same OS permissions may modify local policy, queues or replies;
uncovered tools, arbitrary programs, subprocesses and filesystem races are not
fully mediated. The wrapper cannot guarantee blocking if the provider never
launches it or ignores its result. Independent execution outcome observations and
real provider compatibility checks remain necessary.

Validation includes subprocess pause/release/deny/error checks, independent timeout
and response binding, expiry/late-result fencing, queue concurrency, scoped chart
counts and deduplication, migration, browser interaction and mobile screenshots.
Live synthetic API checks returned valid allow verdicts for a routine README read
and an explicitly requested empty-key-file editor opening. Neither described action
was executed by the test.

Reference: [Anthropic structured output and supported schema constraints](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## Completed validation and local rollout

100 backend tests and all 9 browser tests passed, plus TypeScript and the production
build. Desktop/mobile evidence views and safety chart screenshots were inspected.
The live synthetic end-to-end test held the hook, received Haiku's valid allow,
returned exit 0 without an approval override, and recorded the receipt in about
4.3 seconds. The described read was not executed and its temporary connection was
removed. One user-approved historical replay reproduced the two list-type errors;
no other historical failures were automatically replayed or overwritten.

The local database backup is `data/monitor.before-blocking-20260918-173139.db`.
Migration 0007 preserved all 53 existing evaluation rows. Relay and its two-thread
worker were restarted on the already-used port 8000; worker/key readiness was
verified. Blocking configurations were installed for the three active Codex
Desktop, Codex CLI and Claude Code connections with provider-setting backups.
Agent sessions still need restarting and Codex hook trust where required. Actual
provider execution coverage is not implied by this configuration or synthetic test.
