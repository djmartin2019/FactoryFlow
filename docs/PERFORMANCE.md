# Performance: baseline vs expanded facility

Measured, not estimated. Browser numbers come from the production build (`vite preview`) in headless
Chrome on macOS with an **Intel UHD Graphics 630** (ANGLE/Metal), 1600x900 window, frame-rate limiting and
vsync disabled so frame time is the real CPU+GPU cost, not the 60 Hz cap. Each browser configuration was run
twice; ranges are shown. Node numbers are single-process `FactoryReplay` timings (mean of 5).
Treat absolute FPS as indicative only: a laptop on battery or a projector at a demo will differ.

## Optional overlay

Open the app with `?perf` (or press **P**) for FPS, frame time, draw calls, triangles, mesh count and events
processed per second. Disabled, it costs one boolean check per frame. `window.__ffPerf()` returns the latest
sample for scripted benchmarks.

## Results

| | Baseline | Expanded |
| --- | --- | --- |
| Factory objects (= modeled locations) | 11 | 19 |
| Workstations (3 ASM + 2 QC -> 6 ASM + 3 QC) | 5 | 9 |
| Building footprint | 56 x 32 m (1,792 m2) | 80 x 44 m (3,520 m2, 1.96x) |
| Customer orders / purchase orders (config) | 75 / 50 | 180 / 75 |
| Events generated | 1,834 | 4,073 |
| `events.json` | 917 KB | 2,061 KB |
| Meshes in scene | 68 | 101 |
| Draw calls | 80 | 121 |
| Triangles | 2,211 | 3,673 |
| FPS (median, uncapped, headless) | 271-280 | 196-223 |
| Frame time (median) | 3.6-3.7 ms | 4.6-5.1 ms |
| Events applied per second at 3600x | ~1.2 | ~7.2-7.8 |
| Events applied per second, peak at 86400x | ~92 | ~220 |
| Slider seek in browser (10-100% of timeline) | 2-13 ms | 7-30 ms |
| Full replay, Node | 22 ms | 53 ms |
| Seek to 50% / 100%, Node (incl. reset) | 7.6 / 17 ms | 18 / 39 ms |
| Dashboard KPI + station metrics, Node | 1.6 ms | 4.2 ms |

Observations:

- Cost scales roughly with object count (about +50%), not worse. Worst-case frame time during
  steady playback stayed under ~25 ms in both configurations.
- The worst single frames (280-840 ms) and long tasks (290-1,400 ms) occur once at load, when the JSON is
  parsed and the scene is built. Initial load is the only noticeable slowdown, and it is larger with the
  2x events file.
- No UI slowdown was observed while playing at 3600x or 86400x or dragging the progress slider.
- A full seek at 100% is under 40 ms even in Node; the dashboard refresh (250 ms interval) is ~4 ms.
- Draw calls are higher than meshes/2 because each station has up to 6 material groups plus a label
  sprite. If this ever matters, labels and shared-material parts are the first things to batch.

## Phase 0 baseline (domain core, Node)

Recorded 2026-10-15 for later comparison; deliberately **not** asserted in CI, because wall-clock timings are
flaky across machines. Node 22.22.3, Intel Core i9-9880H @ 2.30 GHz, macOS. Default dataset (seed
`northstar-2026`, 30 days, 4,073 events), mean of 5 runs after one warm-up, single process.

| Operation | Time |
| --- | --- |
| `generateDataset()` (includes reducer checks while generating) | ~311 ms |
| `validateDataset()` | ~150 ms |
| Full replay (`FactoryReplay.step()` over all events) | ~30 ms |
| Seek to 50% including reset | ~11 ms |
| Seek to 100% including reset | ~28 ms |
| `computeKpis` + station metrics, all-time window | ~4 ms |

Correctness baseline: `npm test` (72 tests, including `tests/contract.test.ts` on the committed canonical
fixture) and `npm run validate:data` must pass. Treat a >2x regression in any row above as worth
investigating. The browser results in the tables above predate this run and were not re-measured.

## Demand calibration

Baseline: 75 orders on 3 assembly stations gave 48-60% utilization (mean ~54%). Candidates on the 6-station
floor (utilization over the whole 30 days):

| Orders | ASM-001..006 | QC-001..003 | All checks |
| --- | --- | --- | --- |
| 75 | 37/35/29/24/20/18 | 21/11/8 | pass |
| 150 | 65/70/61/46/43/34 | 39/25/16 | pass |
| **180** | **76/66/67/54/57/55** | **43/29/21** | pass |
| 210 | 79/81/85/67/62/69 | 51/35/23 | pass |

180 was chosen: every assembly station is at 54-76% (mean ~62%, a bit above the baseline's 54% so the bigger
floor looks busy) and the demand surge still queues work. The dispatcher prefers the lowest free station id,
so ASM-001 is always the busiest and QC-003 the quietest.
