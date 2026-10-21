# Release record: 0.1.0 Public Preview

Date: 2026-10-21. The release commit is tagged `v0.1.0`. Scope and checklist:
[`OPEN_SOURCE_DEVELOPMENT_PLAN.md`](OPEN_SOURCE_DEVELOPMENT_PLAN.md) §G.1 and §J.1. What exists: [`STATUS.md`](STATUS.md).

This file records what was checked, how, and what was not. It is evidence, not a claim beyond what is written here.

## 1. Build and correctness

Run locally on the release commit with Node 22.22.3 (CI runs the same five commands):

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run typecheck:app` | pass |
| `npm test` | 30 files; 340 passed, 15 expected failures (`it.fails`: the M3a atomicity corpus, by design) |
| `npm run validate:data` | 16 of 16 checks, 4,455 events; regenerating from the manifest seed reproduces log hash `8cf64c93` |
| `npm run build` | pass; main chunk 824.9 kB (214.7 kB gzip) |

Contracts: event shapes, reducer rules and schema `1.3.0` are unchanged, and the canonical fixture (hash `6ed76381`)
is byte-for-byte unchanged. The **default dataset was regenerated** (log hash `1b408e8e` → `8cf64c93`); see §2.

Clean-clone quick start: `git clone` → `npm install` → `npm run dev` on Node 22.22.3 served the app and
`/data/events.json` in about 3 s with a warm npm cache. The `public/data` symlink resolves after clone.

## 2. Dataset change and migration note

Two deliberate changes regenerate the default dataset. Neither changes an event shape or a reducer rule, so
`SCHEMA_VERSION` stays `1.3.0` and logs generated earlier still replay.

1. **Planning links.** The generator used to link every new work order to every open order line of its product
   (a median of 4 and up to 52 lines per work order; one 6-unit order listed 27 planned work orders). It now links a
   new work order only to the lines that stock on the shelf and earlier work orders do not already cover, taken in
   allocation order (`generator.ts`, `uncoveredLines`). Each work order now links to 1 line, and each line to at most 2
   work orders (when an earlier order covered it only in part). A work order's due date is the earliest due date of
   *those* lines, so release and dispatch priorities shift slightly. Pinned by a regression test in
   `tests/manufacturing.test.ts`. The canonical fixture is unaffected (its orders never overlapped).
2. **Company name and seed.** The fictional manufacturer is renamed from "Northstar Components" to **Larkhaven
   Controls** (decision L6), and the default seed from `northstar-2026` to `larkhaven-2026`. The name was never stored
   in the dataset; only the seed string changes the generated events.

Effect on the demo story (whole 30 days, old → new): 4,651 → 4,455 events; 223 → 210 work orders; shipped customer
orders 145 → 152; material-blocking events 91 → 101; machine failures 12 → 12; station utilization within a few
points per station (busiest station 81% → 74%). Pins updated: event-log hash, final-state hash in
`behaviorPinning.test.ts` (`5c4c0223` → `0af251dc`; only IDs and quantities changed in 10 pinned messages, no decision
or partial-mutation flag changed), the tie census and Rev3 Appendix B (re-measured column added), and the instants in
`bottleneck.test.ts` and `materialShortages.test.ts`. The worked examples in `PLANT_MANAGER_GUIDE.md` §5.6 were
recomputed from the analytics on the new dataset.

**Migration:** none for code. Anyone holding a dataset generated with `northstar-2026` can keep replaying it; to match
0.1.0, run `npm run generate:data`.

## 3. Browser smoke test (Explorer ↔ 3D, both directions)

Scripted run against the production build (`vite preview`) in headless Chrome with WebGL (ANGLE, Metal, Intel UHD
Graphics 630), 1600x1000, driven over the DevTools protocol with no added dependency. The script is not committed
(it is a one-off check, not a CI test). Run again after the dataset change.

| Check | Result |
| --- | --- |
| WebGL available, 3D scene renders | pass |
| Synthetic-data badge visible on Factory Overview and Operations Explorer (it is in the shared header) | pass |
| 3D → Explorer: select a running station, **Open WO-… detail** opens `#/explorer/orders/WO-…` with the drawer | pass (Kitting, WO-0077) |
| Explorer → 3D: **Show in factory** in the work-order drawer returns to the overview with the station selected | pass (ASM-001) |
| Dispatch → customer-order drawer (`#/explorer/dispatch/CO-0117`) | pass |
| Customer order → planned work order → back to the same customer order | pass (CO-0117 → WO-0137 → CO-0117; the order lists 2 planned work orders) |
| Customer order → **Show finished-goods location** selects the shipping bay in 3D | pass (SHP-002) |
| Material Shortages → **Show racks** switches to the shortage overlay and selects the rack | pass |
| Shortage overlay colours match the computed cells | pass by screenshot (Fri 2026-09-11 14:29: Racks A and D highlighted, the others muted) |
| Overlay labels: highlighted objects outlined in the overlay colour, other labels faded | pass by screenshot; Rack A, hidden behind Rack D's label from the default camera, is identifiable by its outlined label |
| Work Orders table after data changes on another Explorer tab | **bug found and fixed** (§6); re-checked: 162 rows for 162 created |
| Queue and utilization overlay colours | looked at, not compared cell by cell |
| WebGL disabled: Explorer fully usable | pass (Dispatch tab rendered and populated; first run) |
| Console errors or uncaught exceptions during the run | none |

Not tested: Firefox and Safari, touch devices, narrow screens, screen readers.

## 4. License and dependencies

- License: **Apache-2.0**, `LICENSE` is the unmodified text from apache.org (SHA-256
  `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`). The owner confirmed on 2026-10-21 that
  they own the code and assets and that no employer or client claim applies.
- `package.json`: `"license": "Apache-2.0"`, version `0.1.0`, still `"private": true` (not published to npm).
- Dependency scan from `package-lock.json` (72 packages):

| License | Count | Shipped in the browser bundle |
| --- | --- | --- |
| MIT | 54 | `three` 0.186.1, `zod` 4.6.5 (the only runtime dependencies) |
| MPL-2.0 | 12 | no (`lightningcss` and its platform binaries, build tool only) |
| Apache-2.0 | 4 | no (`typescript` and test tooling) |
| ISC | 1 | no (`picocolors`) |
| BSD-3-Clause | 1 | no (`source-map-js`) |

No copyleft code is distributed in the bundle. MPL-2.0 applies to the build tool's own files, which are not shipped.

## 5. Assets, names, secrets

| Asset | Origin | Status |
| --- | --- | --- |
| `public/favicon.svg` | Replaced in this release with an original mark (three stations and a flow arrow). The previous file was the Vite logo from the project template | original |
| `public/icons.svg` | Social-network icon sprite (Discord, GitHub, X, Bluesky) from the Vite template, referenced nowhere | **removed** |
| `public/og-v2.png` | Rendered from `design/og.html` by `npm run og` (headless Chrome screenshot) | original; CSS only, system fonts, no external images |
| `docs/images/*.jpg` | Screenshots of this application on the 0.1.0 dataset | original |
| Inter font | Loaded at runtime from Google Fonts, not committed | SIL Open Font License 1.1; the page makes a request to Google Fonts |
| 3D models | None: all geometry is built in code from Three.js primitives | n/a |
| Company name | "Larkhaven Controls" (was "Northstar Components") | invented; see below |
| Customer and supplier names | Invented for the dataset | not checked individually |

- **Company name (L6, closed).** A web search for "Northstar Components" found no exact match but several real
  manufacturers named Northstar, one close in business (contract electronics assembly, cable harnesses, box builds).
  The owner chose **Larkhaven Controls**; a web search (2026-10-21) found no company of that name. This is not a
  trademark clearance.
- **Secrets.** Tracked files and the full history (`git log -p --all`) were searched for private keys, cloud and
  GitHub tokens, API-key and password assignments: nothing found.
- **Personal infrastructure.** `deploy/` now uses placeholder host names (`factoryflow.example.com`) and a
  `$DEPLOY_USER` variable. Earlier commits still contain the owner's server user name and a reference to another site
  on the same host; these are not secrets, and history was **not** rewritten. The public demo URL
  (`factoryflow.djm-apps.com`) is intentionally kept in `README.md` and `index.html`. `SKILL.md` and
  `docs/DashboardInspo.webp` stay gitignored and untracked.

## 6. Fixed during the release pass

- **Planning-link fan-out** (generator): see §2.
- **3D labels hiding highlighted equipment** (rendering): labels are drawn on top of everything, and from the default
  camera Raw Materials Rack A sits behind the labels of racks C and D. With a "Colour by" overlay on, labels of
  highlighted objects are now outlined in the overlay's colour and all other labels fade to 25% opacity (the selected
  object's label never fades). The label-lift rule also had an off-by-one (racks exactly 7 m apart were not lifted),
  so Rack A's and B's labels now sit above C's and D's. Files: `StationLabel.ts`, `Factory.ts`, `SceneManager.ts`,
  `FactoryVisualizer.ts`; the overlay legend says so. Rendering only.
- **Stale Work Orders table** (UI): if the data changed while another Explorer tab was open (for example seeking on
  the Dispatch tab), returning to Work Orders showed the old rows while the cards above showed the new counts. The
  table now keeps its own data key, like every other tab (`OperationsExplorer.ts`). Found while taking screenshots,
  reproduced and verified in the browser; there is no automated DOM test for it.

## 7. Open items

- **Hosted demo.** The demo responded on 2026-10-21 (no login), but it serves the previous deploy until
  `deploy/release.sh` is run for this commit.
- **Push.** The tag `v0.1.0` exists locally; pushing it and publishing GitHub release notes are manual steps.
