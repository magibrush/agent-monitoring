# RFC 007: Incident investigations

Implemented 20 September 2026. Extends RFC 006's operator-triage milestone.

## Workflow

Safety keeps live, individual approvals at the top. Below them, Incidents and Action history separate ongoing investigations from recorded requests. History filters never hide live approvals.

Incidents have a factual title, connection, grouping explanation, linked requests, notes, and an append-only activity log. Start investigating, resolve with a reason, or reopen. Resolution choices are Expected activity, Policy needs adjusting, Issue addressed, and Other. These operations never approve, retry, or change an assessment. Operators are identified as the local operator; authenticated ownership and assignment remain future work.

Create an incident from any action's inspector, or attach it to an open incident on the same connection. Detaching preserves the source action and records the correction. Linked evidence retains the assessment identity rather than silently switching to the latest retrospective result. The request list and investigation activity are paginated. Conversation links open Explorer around the source action. Unknown execution remains unknown even after a release receipt.

## Automatic grouping

The API runs a separate background correlation cycle every two seconds, reading at most 100 completed, failed, or skipped assessments per cycle. It makes no model calls and never participates in a blocking decision. SQLite still has one writer; correlation uses a short busy timeout and retries on a later cycle when storage is busy.

- Built-in prohibitions and judge deny recommendations open a concern immediately. Titles attribute the concern to its source, without claiming malicious intent.
- Custom-policy denials and other blocked requests open a concern after three matching requests within ten minutes. Ordinary Ask me requests do not open one.
- Three evaluation failures, capacity failures, or expirations within ten minutes open a service incident. Service grouping uses the connection and failure category, including across its sessions.
- Concern grouping uses connection, session, finding/policy rule, tool, and a lexically normalized file path. Where a file target is unavailable, exact assessed action hashes must match. No filesystem lookups or shell interpretation are performed.
- Once an incident is open, further matching requests within the ten-minute window attach to it. A later episode creates a linked incident. After resolution, new activity follows the same creation thresholds and links back to the prior investigation. Delayed assessment of an earlier request adds evidence to the closed investigation without reopening it.
- Other incidents in the same session near the same time can appear as possibly related. They are not automatically merged.

Debug assessments and retrospective retries are excluded. Policy simulations do not enqueue assessments and cannot create incidents. The monitor starts from migration time, so existing assessments are not automatically backfilled. A crash resumes from persisted candidate records; candidate classification, grouping, links, and audit entries commit together. Explicit manual attachments take precedence over automatic grouping for the attached assessment.

## Storage and API

Migration 0015 adds incidents, incident_links, incident_activity, incident_candidates, and incident_monitor. Connection deletion cascades through its investigations in the same database transaction. Original source transcripts are untouched. The monitor's installation timestamp survives restarts.

`/api/safety/incidents` supports filtered, paginated listing and manual creation. Detail returns linked evidence, activity, recurrences, and nearby investigations. Separate endpoints change status, append notes, attach actions, and detach links. Revision checks reject stale status changes. Local mutation locking coordinates API edits, correlation, and connection deletion; this is still a single-API-process application.

No incident operation changes a policy, human approval, judge result, or gate receipt. Those decisions retain their existing APIs and exact-request checks. Notes and evidence are local plaintext under the app's existing storage model.

## Validation and rollout

Backend coverage includes thresholds, session/connection isolation, time windows, restart deduplication, exclusions, late assessments, recurrences, manual corrections, unchanged decisions, pagination, and connection deletion. Migration verification upgrades an isolated 0014 database with existing records, downgrades, and upgrades again. Browser coverage exercises the real API from action history through notes, attachment, resolution, reopening, detachment, and Explorer navigation on desktop and mobile.

Build the frontend, back up the local database, apply migration 0015, and restart the API. Existing requests should finish before restarting. The worker contract is unchanged. Historical investigations can be created manually; no model calls or historical replays are needed for rollout.

Local rollout completed after a SQLite backup with no active blocking requests. The API and two-lane worker were restarted; migration 0015 and the incident endpoint were verified. The full backend suite passed during implementation, followed by all 12 incident tests including migration and pending-approval invariants. All 32 browser scenarios passed across the full run and focused rerun after updating two stale UI expectations. TypeScript and the production build pass; the existing bundle-size warning remains.
