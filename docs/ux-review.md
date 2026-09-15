# Independent UX review

Review brief: reason from agent-monitoring and investigation tasks without treating the existing design as fixed. Review performed by a separate agent against screenshots and source.

## Recommended workflow

Spot activity → identify contributing sessions → inspect actions → read surrounding conversation.

## Findings and response

- Combined charts let message outliers obscure actions. Replaced with aligned action and message panels, independent vertical axes, and zero-safe logarithmic/linear scaling.
- Manual resolution was silently replaced with Auto. Explicit buckets now stay exact; large ranges page through windows of at most 600 buckets.
- Brush selection required a second action to aggregate. Replaced with direct drag-to-zoom and Earlier/Later navigation.
- Spikes lacked attribution. Added ranked contributing sessions and direct evidence navigation.
- Mouse-only bucket inspection excluded keyboard users. Added a native bucket selector.
- Top-five results created a dead end. Added pagination; action ranking excludes sessions without calls.
- Zoom controls must not silently change resolution. Zoom-out preserves it; the reset explicitly says Full range · Auto.

## Remaining design work

Simplify the global filter panel with progressive disclosure and removable active-filter chips. Add richer evidence presentation and source timing/provenance diagnostics. When enforcement exists, build an incident queue with decision, outcome, latency, and evidence; do not equate volume or deletion text with maliciousness.

## Simplification review

A subsequent independent review focused on removing overload. Implemented one filter row with advanced options behind More filters; three compact totals; a unified chart toolbar; combined message bars with user/assistant hover breakdowns; per-tool action hover breakdowns; and an inspector closed by default. Removed decorative heading copy, permanent instructions, repeated metric explanations, standalone tool chips, and the separate questions/answers card. Desktop acceptance: both charts and the session-table heading fit at 1440×900 without zooming out.

## Stacks and navigator review

The reviewer endorsed blue/teal stacked messages and a single compact full-domain navigator. Implemented cumulative logarithmic boundaries (never the sum of separately transformed counts), raw-count tooltips, independent coarse overview data, release-to-update handle resizing/panning, keyboard controls, and manual-resolution width limits. No Apply button or instruction paragraph was reintroduced.

## Sticky filters and logarithmic alternatives

Implemented reviewer recommendations: filters and totals stay together while scrolling; Clear all is always present and clears filters, selected sessions, and sort; Session type is a visible filter; All time replaces Fit activity; custom ranges display dates; advanced search has labels and a filter count; session sorting remains beside the table.

No scale behavior was changed. The reviewer notes that cumulative-log stacking has correct totals but misleading proportions: 178 user vs 3,283 assistant messages puts roughly 64% of plotted height in the user segment despite its 5% raw share. Order also affects segment height.

Future variants, ranked:
1. Volume / Compare activity modes: linear stacked bars for volume/composition; logarithmic total dots or line for comparing small activity against spikes, category breakdown on hover. Reviewer preference.
2. Linear stacks plus zoom and explicit outlier isolation. Never silently exclude spikes.
3. Log total-height bars partitioned using raw category shares. Better composition, but segment boundaries no longer correspond to axis counts.
4. Square-root scaling. Gentler compression, but nonlinear stacking still distorts proportions.
