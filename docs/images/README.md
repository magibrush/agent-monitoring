# Screenshot sources

All images capture the real UI using synthetic fixtures. No generated images, private conversations, or live model calls were used.

| Images | Source |
| --- | --- |
| `demo-guided-tour.png`, `demo-overview.png`, `demo-incident.png`, `demo-connections.png` | `frontend/demo-tests/demo.spec.ts`; actual demo server |
| `lab-scenarios.png`, `lab-results.png` | `frontend/lab-tests/lab.spec.ts`; actual Lab server with simulated responses |
| `overview.png` | `frontend/tests/workflows.spec.ts` |
| `incident.png` | `frontend/tests/incidents.spec.ts` |

See [testing](../testing.md) to regenerate. Main-suite captures go to ignored `data/qa/`; demo captures go to `frontend/test-results/`. Lab captures go to `data/lab-desktop.png` and `data/lab-results.png`; copy them here as `lab-scenarios.png` and `lab-results.png`. Inspect every new capture for private content before copying it here. Fixture timestamps/counts may change between runs.
