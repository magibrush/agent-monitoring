# Screenshot provenance

These are actual Relay UI captures using synthetic browser-test fixtures, reviewed before inclusion. No image generation, private conversations, or live model calls were used.

| Image | Source |
| --- | --- |
| `demo-guided-tour.png` | `frontend/demo-tests/demo.spec.ts`: spotlight tour highlighting Overview in the actual app |
| `demo-overview.png` | `frontend/demo-tests/demo.spec.ts`: actual demo server with four synthetic Trailhead sessions |
| `demo-incident.png` | Same demo walkthrough: fictional denied upload with scripted assessment and cited analysis |
| `demo-connections.png` | Demo walkthrough: provider cards showing fictional sources after finishing the spotlight tour |
| `overview.png` | `frontend/tests/workflows.spec.ts`: dashboard capture with synthetic session records |
| `incident.png` | `frontend/tests/incidents.spec.ts`: automated incident fixture with scripted assessment and analysis |

Run the browser suite as described in [testing](../testing.md). Its original captures are written to ignored `data/qa/`. Review newly generated captures before copying them here; never substitute screenshots from the personal monitoring database. Timestamps and fixture counts may change between runs.

The dedicated demo suite writes its captures to `frontend/test-results/`. The demo images were visually reviewed for fictional content and accurate scripted-mode labels before inclusion.
