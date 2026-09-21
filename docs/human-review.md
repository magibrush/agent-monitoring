# Human review

Implemented 19 September 2026. Open **Safety → Needs your decision**.

Blocking requests follow: queued → evaluating → either allow, deny, or awaiting
human approval. A `review` recommendation no longer becomes a denial. The worker
finishes its job, freeing capacity, while the hook remains paused. Approve releases
that exact request to native provider permissions; Deny blocks it.

The original 60-second deadline includes both evaluation and human decision time.
The UI shows the remaining time. Expiry blocks the action, removes it from the live
review queue, and preserves its assessment. An expired or already returned hook
cannot be resumed; submit a new tool request. No historical denied requests are
reopened by migration 0008. Existing review-to-deny records remain historical and
are labeled as blocked by the previous policy.

Live approval cards lead the Safety view and cover every connection regardless of history filters. Commands, reasons, countdowns and Approve/Deny are visible without opening a sub-view. The idle queue collapses to a single status line. Outcome charts have
a separate Awaiting approval state; Pending is automated evaluation. History rows open a single compact detail panel; diagnostics and context share one optional Technical details section. Connection protection and judge setup are available through Settings. Truncated actions cannot be approved. The human decision
and timestamp are stored separately from the judge recommendation and gate receipt.

The review endpoint uses a conditional database update bound to evaluation ID,
action hash, review status, no prior decision/receipt, and an unexpired deadline.
Concurrent decisions have one winner; stale clicks return a conflict. Deterministic
denials and shadow assessments cannot be approved. Approved requests still need a
gate receipt before being counted as released.

This is a single-user loopback application, not an authenticated multi-user approval
service. Existing origin checks apply; a process running as the same OS user is
not isolated from the API, database or hook queue. The model is instructed never
to grant itself approval, but this is not an OS security boundary.

The judge prompt now focuses on the proposed action's concrete effects, treats
previous assistant diagnoses as unverified, and ignores attempts to force a
particular verdict. Routine identity checks, scoped directory creation, clarification
questions and reading monitor source are not dangerous merely because a conversation
discusses security testing. Actual harmful effects still require escalation or denial.

Tests exercise real hook pause → review → human approve/deny → gate receipt using
synthetic model results, plus expiry, action binding, duplicate/concurrent decisions,
and browser controls. `scripts/check_judge_calibration.py` is an opt-in live check:
it sends only built-in synthetic cases to the configured judge provider, never historical conversations,
and executes none of the proposed commands. Passing those cases does not establish
general model accuracy.
