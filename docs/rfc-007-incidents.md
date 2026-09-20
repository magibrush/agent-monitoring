# RFC 007: Needs attention

Implemented 20 September 2026. Extends RFC 006's operator-triage milestone.

## Purpose and workflow

Help people find repeated interruptions, adjust the rule responsible, and check subsequent activity. Individual successful blocks stay in history instead of becoming another task. Live approvals remain at the top of Safety and are unaffected by inbox filters or dismissals.

Needs attention uses the same compact list and inspector as action history. Each item explains the observed pattern and offers a relevant next step. A policy interruption opens the exact rule in the existing draft, or the applied policy if no draft exists. A missing rule is reported without recreating it. Existing draft edits are preserved.

After saving changes, **Test affected requests** compares the draft against up to 500 of the item's latest saved requests. Results show previous recommendations and proposed policy decisions. Built-in protections retain priority. Incomplete, redacted or truncated requests are marked unavailable. No judge runs, decisions change, or requests execute. This focused check does not mark the whole draft as simulated; the existing full simulation and application flow remains available.

After applying a changed rule, the item reports subsequent assessments on its connection, up to the latest 2,000. It counts blocking requests whose recorded winning rule still required review or denial, and states when no later assessments exist. This is an observation about later activity, not proof that a problem was fixed. Debug assessments and retrospective retries are excluded. Rule removal and policy pausing do not imply success.

Service items open the existing request timing inspector and link to protection settings. Notes, audit activity and manual attachments are optional. **Dismiss** requires no resolution form and does not alter policy or pending approvals. **Show again** restores the item. Historical resolved records remain readable.

## Automatic grouping

A separate background cycle reads up to 100 eligible assessments every two seconds, including pending human reviews. It never calls a model or participates in a blocking decision. SQLite uses a short busy timeout so correlation yields to gate writes.

- A single successful block stays in action history.
- A single high-risk deny recommendation in shadow mode opens an item, since Relay did not block that request. Execution remains unknown unless recorded elsewhere.
- Three interruptions from the same policy rule on one connection within ten minutes open one item, including across files and sessions. The winning rule is recovered from the policy version assessed, using the same priority order as matching.
- Other repeated denials use connection, session, finding, tool and normalized file path. Without a file target, assessed action hashes must match. Normalization is lexical; it never reads target files.
- Three evaluation failures, capacity failures or expirations within ten minutes open a service item, grouped by connection and failure category.
- Matching activity keeps updating an open item even after an idle gap. Three new matching requests within ten minutes bring a dismissed item back under the same ID, with an explanation. Earlier requests that complete late attach to the dismissed record without reopening it.
- Legacy records resolved with an explicit reason retain the previous linked-recurrence behavior.

Debug assessments and retrospective retries are excluded. The monitor starts from installation time, so old assessments are not automatically backfilled. Candidate records make correlation restart-safe; classification, links and activity commit together. Manual attachment takes precedence for that assessment. Existing saved items are preserved during this update.

## Storage and API

Migration 0015 introduced incidents, links, activity, candidates and the monitor cutoff. This refinement needs no new migration. Connection deletion cascades through its saved items in the same transaction. Source transcripts are untouched.

`/api/safety/incidents` retains filtered listing, manual creation, notes, attachment, detachment and revision-checked status changes. Detail adds a factual summary, recorded winning rule and observed follow-up. `POST /api/safety/incidents/{id}/preview` requires the current policy revision and a saved draft. It returns a bounded comparison without mutating policy state. Local locks coordinate correlation, edits, policy comparisons and connection deletion; deployment remains single-process.

Evidence retains its original assessment identity. Request lists and activity are paginated, and links open Explorer at the source request. No inbox operation approves, retries or replaces an assessment. Notes and evidence remain local plaintext under the existing storage model.

## Validation and rollout

Backend tests cover quiet successful blocks, grouping across sessions, thresholds, time windows, restart deduplication, exclusions, late assessments, dismissal and recurrence, unchanged approvals, manual corrections, pagination, connection deletion, draft revision checks, focused comparisons and observed follow-up. Browser tests exercise both the optional manual workflow and the rule-review, comparison, apply and return path on desktop and mobile.

Build the frontend and restart the API after active blocking requests finish. Existing migration 0015 and worker contracts are unchanged. Previously installed instances retain their saved items; new correlation uses the quieter rules.

Validation completed: 199 backend tests passed, followed by the 14 incident tests after the final search change. All 33 existing browser scenarios passed; the final focused run passed four scenarios including the new service diagnostics path (34 distinct scenarios in total). TypeScript and the production build pass; the existing bundle-size warning remains. The local API was restarted after a database backup and a check for active blocking requests. Health, worker heartbeat and the summary endpoint were verified.
