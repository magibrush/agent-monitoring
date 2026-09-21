# Usage reference

For installation and agent connections, see [setup](setup.md).

## Find a conversation

**Overview** summarizes activity; opening a session takes you to **Explorer**. Connection, time, search, and action filters combine with AND and persist between these views. **Clear all** resets scope, selection, and session sorting.

Search defaults to case-insensitive whole words or phrases: `dance` does not match `guidance`. **More filters** offers substring matching, tool arguments/output, titles-only search, and internal reviews. Search selects matching sessions; charts show their activity, not just occurrences of the search term.

Action filters select sessions with matching calls and count those calls while retaining message totals. Categories such as deletion are text-based search hints, not safety verdicts. **Show surrounding conversation** broadens matching within the selected time range. Setup context and copied Codex internal approval reviews are hidden by default.

## Read the charts

Select **Sessions**, **Messages**, or **Actions** to change the Overview chart. Click a bar to inspect its contributors; open a conversation to see records in that range.

| Measure | Meaning |
| --- | --- |
| Sessions | Distinct sessions with activity in each bucket; a session can appear in several buckets. |
| Questions / answers | User / assistant messages, including assistant commentary; injected setup context is excluded. |
| Actions | Recorded tool requests, excluding tool results. A request is not proof of success. |
| Tokens | Provider-reported usage across requests, including cached input. Missing breakdowns show `—`; `≥` marks a partial total. |

Dates display in your browser timezone; storage uses UTC. Ranges exclude their end timestamp. Recent presets roll forward; custom ranges stay fixed. Drag to zoom, use the navigator to resize or pan, or enter an exact range. Manual intervals show at most 600 buckets per window. Automatic intervals target roughly 100. Thirty-day and year buckets are fixed durations, not calendar boundaries.

**Color by** switches between activity type, conversation, and supported token/safety breakdowns. Tools and conversations rank independently within each bar: colors identify ranks, not permanent identities. Ten ranks are shown, with the rest grouped as Other. Message roles keep fixed colors. Hover for names and exact counts.

Linear scale shows proportional segment sizes. Logarithmic stacks use cumulative `log10(1 + count)` boundaries: totals remain correct, but segment heights are not proportional shares. Both use raw counts in tooltips. Charts use recorded timestamps; they do not reconstruct execution timing.

### Token accounting

Codex cached input is already included in its input total; Claude cache reads/writes are added to uncached input. Output includes reasoning usage where reported. Codex cumulative counters become increments, and repeated Claude message IDs count once. Usage is neither estimated billing nor current context size, and adds no messages or actions.

## Manage connections

One connection watches an agent source across projects and terminals. Codex Desktop and CLI can share a profile but use transcript creation provenance to separate sessions; resuming elsewhere does not move them. Archives are separate sources. Claude project folders and nested subagents have their own session identities.

Use **Check source** for path and provenance errors. Relay cannot infer another terminal's environment or discover remote hosts. Overlapping folders or copied profiles can count overlapping history in separate connections.

**Pause** stops transcript collection and catches up on resume; blocking hook collection remains active. **Delete** removes imported records and checkpoints, preserving source transcripts. Reconnecting imports available history again. Deletion is not secure erasure of SQLite files or backups. Disable live hooks before deletion to remove provider handlers too.

Transcript rewrites replay automatically while retaining previously observed history. Changed contents can add observations, so Relay is not an exact mirror of the latest file. See [recovery details](transcript-recovery.md). Retired Claude Desktop imports remain hidden; Claude Code uses a separate adapter.

## Review safety outcomes

**Safety** shows live reviews first, followed by incidents and action history. Live reviews cover all connections regardless of history filters. Open an action to distinguish:

- **Assessment:** the policy or judge's recommendation.
- **Gate receipt:** the decision delivered by Relay's hook.
- **Execution:** a separately recorded outcome, if available.

Transcript-only actions are **Not assessed**. Shadow assessments are advisory. Dismissing an incident does not approve a tool or change a rule; new suspicious evidence can reopen it. Incident analysis cites saved conversation evidence and runs separately from live decisions.

See [human review](human-review.md) for approvals and notifications, [policies](policies.md) for rules, and [incident design](rfc-007-incidents.md) for grouping and analysis.

### Debug and performance

**Safety → Settings → Debug** can force Review, Allow, or Deny on new assessments without model API calls. It overrides custom policy routing and the judge; built-in prohibitions, incomplete-action checks, deadlines, and human approval checks remain enforced. Shadow results stay advisory. Turn Debug off to restore normal evaluation. Existing assessments retain their configuration; debug results are excluded from production metrics.

**Settings → Performance** shows the last 24 hours of automatic pause p95, failures, expiries, and missing receipts. **Action → Technical details** separates intake, queue, model attempts, human response, publication, and delivery. Missing historical measurements show `—`. The API also exposes p50/p95/p99 and aggregate blocked-agent time, bounded to the latest 10,000 blocking requests with truncation disclosed.

The gate deadline is 60 seconds. Automated evaluation ends 32 seconds before it, reserving 30 seconds for review and two for delivery. Blocking attempts have a 10-second wall-clock limit and at most one retry if time remains. Budget exhaustion, provider failure, and overload block the request.

With two workers, one lane is reserved for blocking and one handles blocking or shadow work. One-worker mode is blocking-only. Admission allows up to 1,000 jobs, reserves 100 slots for blocking, and caps each connection at 20 pending blocking requests. These are local limits; SQLite contention can still delay decisions. Recorded pause starts at wrapper entry, excluding earlier provider scheduling and interpreter startup.

For verification commands and the optional live calibration corpus, see [testing](testing.md).
