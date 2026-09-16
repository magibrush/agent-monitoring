# RFC 003: Live hook observation

Status: Implemented; local smoke check confirmed by the user on 16 September 2026.

Relay has received hook observations for Codex CLI and Claude Code, with no hook
errors reported by either connection. Codex Desktop is configured but has not yet
reported a hook. This confirms local receipt for the two CLI integrations, not
complete coverage of every tool, outcome, or provider version.

Local rollout: database backed up and migrated to revision 0004. Observers installed
for the existing Codex Desktop, Codex CLI and Claude Code connections, preserving
provider settings. Relay runs as one server at http://127.0.0.1:8001.

Relay now accepts read-only tool lifecycle observations alongside local transcripts.
Connections offer **Set up live hooks**, showing the target profile settings and the
exact observer configuration before enabling. Setup merges Relay handlers, backs up
existing settings, and preserves other hooks. Disable removes only that connection's
handlers. Archives and individual Claude project directories remain transcript-only;
automatic setup requires the profile's `sessions` or `projects` directory.

## Delivery and correlation

The dependency-free observer reads stdin and atomically saves one local envelope per
notification. It emits no stdout, stderr, permission decision, rewritten input, or
model context, and exits zero on errors. Its configured timeout is three seconds.
It performs no network requests. Relay need not be running. Payloads are limited to
1 MB; the queue has an approximate 256 MB cap. Capture failures are recorded locally
and shown on the connection. Transcripts remain the recovery feed when notifications
are unavailable or dropped.

A collector checks the queue every 0.5 seconds, up to 100 envelopes per connection
per cycle. The UI refreshes every two seconds. These are polling intervals, not a
hard latency guarantee: database contention, transcript collection and provider
flush timing can delay visibility.

Routing validates the transcript path against the connection root and reads its
identity/provenance. Claude subagents retain separate identities. Shared Codex
Desktop/CLI profiles are routed by transcript creation provenance. Notifications
without a safe identity are retained for diagnosis rather than guessed into a chat.
Missing/incomplete transcripts are retried. Malformed envelopes are quarantined as
`.bad`. Raw observations live in `hook_observations`.

An exact connection/session/tool-call ID associates an observation with one action.
A hook-first action becomes the canonical transcript action when its record arrives;
transcript-first observations attach to the existing action. Commit precedes queue
removal, and a stable fingerprint prevents replay from duplicating observations.
Messages and tool-result records still come from transcripts. Nested Codex tools
without matching transcript call IDs remain hook-only; no argument/time guessing is
used to merge unrelated actions.

## Outcomes and boundaries

Explorer distinguishes hook-only actions from actions seen in both feeds. Requests,
completed operations, failures, denials and unknown outcomes remain separate.
Late pre-hooks do not regress results. Conflicting terminal observations are unknown.
Claude's success and failure events are distinct; its PermissionDenied event covers
auto-mode denials only. Codex PostToolUse may include non-zero command exits, so
opaque output stays unknown; structured exit codes and error flags are recognized.
An absent post-hook does not imply success or denial. No prevention or dangerous-action
classifier is implemented in this phase.

Provider references: [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Claude Code hooks](https://code.claude.com/docs/en/hooks), checked 16 September 2026.
Codex requires review/trust in `/hooks`; hosted and some specialized tools lack hook
coverage. Restart provider sessions after configuration changes. Installed versions
here are Codex CLI 0.154.0-alpha.6.2 (hooks enabled) and Claude Code 2.1.273.
Installation is shown as **waiting for first hook** until an actual receipt occurs.

Pause retains queued notifications for catch-up. Disable stops new capture. Connection
deletion removes imported observations and deactivates its queue marker; stale provider
handlers become no-ops. To remove those handler definitions too, disable hooks before
deleting the connection. Queued files and configuration backups remain local plaintext.

## Validation

57 backend tests passed, including both ingestion orders, duplicate delivery, delayed
pre-hooks, outcome uncertainty, partial queue files, offline replay, pause/resume,
batch limits, profile routing, subagents, configuration merge/disable and silent
observer failures. Eight browser tests passed, including the observer subprocess,
live collection, unchanged action totals after transcript arrival and mobile setup.
TypeScript and production build passed. Automated tests use synthetic provider
payloads. The subsequent local smoke check recorded hook receipt for Codex CLI and
Claude Code, and the user reported that the integration appears to work. A separate
Desktop receipt check and broader tool/outcome compatibility testing remain open.

## Next step

Extend live compatibility checks across tools, failures, denials and subagents.
Then design dangerous-activity flagging and optional pre-execution enforcement as
a separate phase, with explicit timeout and failure behavior. This release remains
observation-only.
