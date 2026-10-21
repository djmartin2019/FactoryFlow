# Release record: 0.1.0 Public Preview

Date: 2026-10-21. Base commit `c5d9c66`; the release commit is tagged `v0.1.0`. Scope and checklist:
[`OPEN_SOURCE_DEVELOPMENT_PLAN.md`](OPEN_SOURCE_DEVELOPMENT_PLAN.md) §G.1 and §J.1. What exists: [`STATUS.md`](STATUS.md).

This file records what was checked, how, and what was not. It is evidence, not a claim beyond what is written here.

## 1. Build and correctness

Run locally on the release commit with Node 22.22.3 (CI runs the same five commands):

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run typecheck:app` | pass |
| `npm test` | 30 files; 339 passed, 15 expected failures (`it.fails`: the M3a atomicity corpus, by design) |
| `npm run validate:data` | 16 of 16 checks, 4,651 events; regenerating from the manifest seed reproduces log hash `1b408e8e` |
| `npm run build` | pass; main chunk 823.9 kB (214.3 kB gzip) |

Contracts unchanged: canonical fixture hash `6ed76381`, event-log hash `1b408e8e`, schema `1.3.0`. No migration.

Clean-clone quick start: `git clone` → `npm install` → `npm run dev` on Node 22.22.3 served the app and
`/data/events.json` (2.5 MB) in about 3 s with a warm npm cache. The `public/data` symlink resolves after clone.

## 2. Browser smoke test (Explorer ↔ 3D, both directions)

Scripted run against the production build (`vite preview`) in headless Chrome with WebGL (ANGLE, Metal, Intel UHD
Graphics 630), 1600x1000, driven over the DevTools protocol with no added dependency. The script is not committed
(it is a one-off check, not a CI test).

| Check | Result |
| --- | --- |
| WebGL available, 3D scene renders | pass |
| Synthetic-data badge visible on Factory Overview and Operations Explorer (it is in the shared header) | pass |
| 3D → Explorer: select a running station, **Open WO-… detail** opens `#/explorer/orders/WO-…` with the drawer | pass (Wiring & Termination A, WO-0053) |
| Explorer → 3D: **Show in factory** in the work-order drawer returns to the overview with the station selected | pass (ASM-003) |
| Dispatch → customer-order drawer (`#/explorer/dispatch/CO-0127`) | pass |
| Customer order → planned work order → back to the same customer order | pass (CO-0127 → WO-0155 → CO-0127) |
| Customer order → **Show finished-goods location** selects the shipping bay in 3D | pass (SHP-002) |
| Material Shortages → **Show racks** switches to the shortage overlay and selects the rack | pass |
| Shortage overlay colours match the computed cells (at Tue 2026-09-15 00:04: only `INV-001`, 7 blocked orders) | pass by screenshot: Rack A drawn in the overlay's hot colour, other racks muted. From the default camera Rack A is mostly hidden behind other labels |
| Queue and utilization overlay colours | looked at, not compared cell by cell |
| WebGL disabled: Explorer fully usable | pass (Dispatch tab rendered and populated) |
| Console errors or uncaught exceptions during the run | none |

Not tested: Firefox and Safari, touch devices, narrow screens, screen readers.

## 3. License and dependencies

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

## 4. Asset provenance

| Asset | Origin | Status |
| --- | --- | --- |
| `public/favicon.svg` | Replaced in this release with an original mark (three stations and a flow arrow). The previous file was the Vite logo from the project template | original |
| `public/icons.svg` | Social-network icon sprite (Discord, GitHub, X, Bluesky) from the Vite template, referenced nowhere | **removed** |
| `public/og-v2.png` | Rendered from `design/og.html` by `npm run og` (headless Chrome screenshot) | original; CSS only, system fonts, no external images |
| `docs/images/*.jpg` | Screenshots of this application | original |
| Inter font | Loaded at runtime from Google Fonts, not committed | SIL Open Font License 1.1; the page makes a request to Google Fonts |
| 3D models | None: all geometry is built in code from Three.js primitives | n/a |
| Synthetic names (customers, suppliers, "Northstar Components") | Invented for the dataset | see §6 |

## 5. Secrets and personal infrastructure

- Tracked files and the full history (`git log -p --all`) were searched for private keys, cloud and GitHub tokens,
  API-key and password assignments: nothing found.
- `deploy/` now uses placeholder host names (`factoryflow.example.com`) and a `$DEPLOY_USER` variable. Earlier
  commits still contain the owner's server user name and a reference to another site on the same host. These are
  not secrets; history was **not** rewritten.
- The public demo URL (`factoryflow.djm-apps.com`) is intentionally kept in `README.md` and `index.html`.
- `SKILL.md` (private hosting notes) and `docs/DashboardInspo.webp` stay gitignored and untracked.

## 6. Open items (do not block the tag, owner decisions)

- **L6, the name "Northstar Components".** A web search (2026-10-21) found no company of exactly that name, but
  several real manufacturers use "Northstar", including Northstar Electronics (contract electronics assembly, cable
  harnesses, box builds), which is close to the fictional plant's business. This is not a trademark clearance.
  Renaming would regenerate the dataset and change both pinned hashes, so it is a separate, deliberate PR if chosen.
- **Hosted demo.** The demo responded on 2026-10-21 (no login), but it serves the previous deploy until
  `deploy/release.sh` is run for this commit.
- **Push.** The tag `v0.1.0` exists locally; pushing it and publishing GitHub release notes are manual steps.

## 7. Findings recorded during the release pass (not fixed here)

- **Planning-link fan-out.** The synthetic planner nets each new work order against every open order line for that
  product (`generator.ts`, `createProductionOrder`). A work order links to a median of 4 demand lines and up to 52.
  As a result, a 6-unit customer order such as CO-0127 lists 27 planned work orders by Tue 2026-09-29. The UI
  already calls this a planning link, and it is now listed in the README's known limitations. Changing it is a
  generator change (new hashes) and belongs with serial-unit traceability (P8), not here.
- **3D occlusion.** From the default camera, Raw Materials Rack A is hidden behind the labels of racks B, C and D,
  so a highlighted Rack A is hard to see (covered by "3D labels can crowd" in the README).
