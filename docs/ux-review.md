# Historical UX review

Development review record; some designs below were later replaced. See [usage](usage-reference.md) for the current interface.

The review focused on one workflow: spot activity → identify sessions → inspect actions → read surrounding conversation.

## Main changes

- Kept filters, totals, and time controls together; moved advanced options behind More filters.
- Added direct zoom/pan, exact intervals, keyboard inspection, contributor navigation, and pagination.
- Removed repeated instructions, decorative copy, and redundant controls.
- Added bounded tooltips and desktop/mobile layout checks.

## Chart finding

Cumulative logarithmic stacks preserve totals but distort segment proportions and depend on ordering. In one example, 178 user messages occupied roughly 64% of the plotted height alongside 3,283 assistant messages, despite representing only 5% of the count.

The reviewer preferred linear stacks for composition and a logarithmic total line/dot view for comparing spikes. Alternatives included linear stacks with zoom or outlier isolation. Current logarithmic views retain raw tooltip counts and explain that heights are not proportional shares.
