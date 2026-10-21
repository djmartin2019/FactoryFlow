# FactoryFlow: open-source development plan

Status: **release strategy restructured on 2026-10-17 (three releases: 0.1.0 Public Preview, 0.2.0 Source Independence, 0.3.0
Lakehouse Reference).** Scope changes R1 to R8 were accepted earlier the same day and applied to
`SOURCE_INTEGRATION_PLAN_REV3.md` (Amendment A1) and `FACTORYFLOW_DESIGN.md`; this revision adds Amendment A2 to Revision 3
(M3b-core contract, legacy-reducer timing) and proposed S1 metric definitions to `KPI_DEFINITIONS.md`. Written against `main` at
`de87e12`. No roadmap item has been implemented.

**Revision 2026-10-20: investigation-first direction.** Product emphasis moves from "more dashboards" to an *investigation tool*: a manager
finds out what is actually happening in the plant, follows the evidence, and sees how part delivery times and shipping affect customer dates. This adds
capabilities P13 to P16 (§E), slices S7 to S12 (§E.3), a "Domain" lane for the one schema change (§F.1), a new release **0.1.x Investigation** and shipping
in 0.2.0 (§G.1a, §G.2), and decisions L12 to L15 (§L). Release **0.1.0 is unchanged**: still observed facts only, no forecasts. Nothing in this revision is
implemented; `STATUS.md` still governs what exists.

**Authority.** This document defines release scope, order and readiness. It does not duplicate specifications:
`SOURCE_INTEGRATION_PLAN_REV3.md` is authoritative for source-integration behavior (including §7.4a, the M3b-core contract);
`KPI_DEFINITIONS.md` is authoritative for analytical metric semantics; `STATUS.md` is authoritative for what exists today;
`FACTORYFLOW_DESIGN.md` records domain intent. Where this plan restates something from them it is a summary and the
source document wins.

Docs convention: this repository keeps planning and reference documents flat in `docs/` with upper-case names
(`STATUS.md`, `ARCHITECTURE.md`, `SOURCE_INTEGRATION_PLAN_REV3.md`), so this file follows that.

## Contents

- A. Project vision and scope
- B. Engineering principles
- C. Current state (verified)
- D. Target reference architecture
- E. Product capability roadmap (E.4: investigation, part lead time, ETA and shipping slices)
- F. Technical development roadmap
- G. Release roadmap: 0.1.0, 0.1.x Investigation, 0.2.0, 0.3.0 (G.0 definitions and maturity levels)
- H. Databricks reference integration (release 0.3.0)
- I. Deferred and out-of-scope work
- J. Definition of done by release
- K. Recommended next steps
- L. Decisions for the owner

---

## A. Project vision and scope

**FactoryFlow is an open-source manufacturing intelligence application and engineering reference
implementation.** It shows how manufacturing domain modeling, event-driven state, operational analytics,
source-independent data integration and interactive 3D visualization fit together in one understandable
codebase.

### Who it is for

| Audience | What they should get |
| --- | --- |
| The owner | A substantial project to learn from, explain and maintain |
| Engineers and contributors | A readable, tested, documented architecture with honest statements of what works |
| Manufacturing and data practitioners | A worked example of work-order traceability, bottleneck, quality and dispatch analysis, with defined KPIs |
| Data-platform engineers | A reference for feeding an external source (first example: Databricks) into the same analytics |

### Product direction: an investigation tool

The dashboard should help someone *discover* what is happening, not only display it. Three principles guide every new slice:

1. **Surface, then explain, then trace.** An exceptions list says what deserves attention; each entry carries a one-line evidence statement; each statement links
   to the records behind it (order, work order, work center, material, shipment, 3D object) and keeps the path back.
2. **Observed first, forecast second, never mixed.** Observed facts (what happened) and forecasts (what we expect) are separate, separately labelled, and
   each forecast states its inputs. A forecast ships only after the observed figures it depends on exist.
3. **Part delivery time is a first-class input.** Per-part lead time (standard and observed) is a metric in its own right and the input to the
   material-delay term of a work-order ETA (§E.3, S9 and S10).

### Goals (in priority order for the first release, 0.1.0)

1. **A public demo that works with nothing installed or paid for**: synthetic data, no login, no backend.
2. **Manufacturing intelligence that answers real questions**, each tied to a definition and a test (§E).
3. **Proof of source independence** (release 0.2.0): the app runs from a second, independently shaped source (§F, M6a).
4. **Credibility as an engineering project**: clone, run, understand, extend (§G).
5. **An optional enterprise reference** (Databricks, release 0.3.0), built only after the above (§H).

### Success looks like

- A stranger opens the hosted demo, finds a late customer order, follows it to its linked work orders, sees where
  the work order's time went and which conditions plausibly contributed (indicative, not proven causes), and sees that
  work center in the 3D plant, in under two minutes.
- A stranger clones the repo and has the same thing running locally with `npm install && npm run dev`.
- An engineer can read `ARCHITECTURE.md` and the Revision 3 plan and answer "how do I add a new source?"
  and "where does this number come from?" without asking.
- Every claim in the README is backed by a test, a recorded measurement, or an explicit "planned" label.

### What it is not (for now)

Not a commercial SaaS. See §I. This plan neither builds for nor rules out that future; it only declines to pay
for it now.

---

## B. Engineering principles

Carried over from `CLAUDE.md`, the design doc and Revision 3 (still correct), with the additions marked **new**.

1. **Separation of layers is the project's main asset.** Domain core (`src/manufacturing/`), simulation
   clock, analytics, rendering. Dependencies point down. Analytics and the domain never import the DOM or Three.js.
2. **Every on-screen number traces to events and state**, and its definition lives in `KPI_DEFINITIONS.md`
   before the card or chart is built.
3. **Synthetic, observed and forecast data stay distinguishable.** The demo stays labelled synthetic.
4. **The reducer is strict and atomic; ingestion is where messiness is handled.** Never fabricate history to
   hide missing or ambiguous data (Rev3 §1, §7).
5. **Determinism is a tested property**: seeded generation, order-independent candidate log, hash-pinned
   canonical fixture. Contract changes mean a deliberate fixture update, `SCHEMA_VERSION` bump and migration note.
6. **Platform independence.** The domain model and adapters know nothing about Databricks or any vendor.
   Distributed transformation (set-based) and sequential domain logic (ordered, stateful) are different
   jobs and live in different places (§H.2).
7. **Thin vertical slices.** Each change delivers something visible and tested, in its own reviewable PR.
8. **New: the application must be useful without 3D, and 3D must earn its place.** Every analytical view is
   reachable from the 2D Explorer; the 3D scene is an additional way to navigate and contextualize it.
9. **New: no speculative generality.** An abstraction, dependency or config format needs a named, present
   consumer. If it only serves a hypothetical customer, it is in §I.
10. **New: documentation that says "implemented" must be checkable.** `STATUS.md` is the single source of
    truth for what exists; other docs link to it instead of restating it.
11. **New: measure before claiming.** Performance and capability statements cite a test or a recorded
    benchmark with date and machine, as `PERFORMANCE.md` already does.

---

## C. Current state (verified)

Verification performed for this plan, 2026-10-17: read all `docs/*.md`, `README.md`, `CLAUDE.md`; inspected
`src/`, `tests/`, `scripts/`, CI and `git log`; ran `npm test` (**237 passed, 15 expected-fail, 252 total, 20 files**),
`npm run typecheck` (clean) and `npm run validate:data` (**16 checks passed, 4,651 events, log hash `1b408e8e`**).
`npm run typecheck:app` and `npm run build` were not run. Browser behavior was not re-verified.

### C.1 Application capabilities that exist

Source: `docs/STATUS.md`, cross-checked against the file tree.

| Area | Verified in repository |
| --- | --- |
| Domain | Event-sourced core, 22 event types, schema `1.3.0`, seeded generator, reducer invariants (`InvariantViolation`), dataset validation |
| Manufacturing model | Products with BOMs; per-product routings (NCP-100/200/300); work centers distinct from stations; dispatch per operation; sequence-dependent changeovers; pooled equipment; quality inspection with rework; machine downtime; supplier POs and receipts; material shortage blocking; customer orders and shipments |
| Analytics | 6 KPIs with definitions; work-order summaries/detail/timeline; work-center queues, load and bottleneck candidate; equipment load; good-units throughput; BOM cost view |
| UI | Dashboard, playback (60x to 86400x, seek), activity feed, station table/details, Operations Explorer (work orders, work centers, BOM, throughput; an Inventory tab now shows stock by location and item) |
| 3D | Three.js plant with selection, status colour, queue buffers per work center, bottleneck highlight, shift-aware rendering |
| Process | CI (typecheck, typecheck:app, test, validate:data, build), canonical fixture contract tests, recorded perf baselines, static-hosting scripts (`deploy/`), public roadmap page |

### C.2 Source-integration milestones

You supplied "M0, M1, M2 complete". The repository supports that:

| Milestone | Evidence in repo | Status |
| --- | --- | --- |
| **M0** characterization, atomicity harness, baseline | `tests/atomicity.test.ts`, `tests/behaviorPinning.test.ts`, `tests/orderingCensus.test.ts`, `tests/helpers/*`, `tests/legacy/state.ts`, `scripts/bench-load.ts`; 15 `it.fails` entries are the documented partial-mutation cases; baseline rows in `PERFORMANCE.md` | Confirmed |
| **M1** contracts, validation primitives, identity, rule classification | `src/sources/{types,canonicalJson,identity,validation}.ts`, `docs/REDUCER_RULES.md` + `tests/reducerRules.test.ts`, `tests/sources/*`; `zod` pinned `4.6.5` | Confirmed |
| **M2** simulation wire format, emitter, adapter | `src/sources/simulation/*`, `tests/sources/simulationRoundTrip.test.ts`; `validate:data` still reproduces `1b408e8e`; STATUS notes round trip is exact | Confirmed (round-trip test passes; I did not independently re-derive the key-order claim) |
| M3a through M7 | no implementation (`src/sources/` has no ingest, ordering or quarantine; `tests/sources/` has no ingest or fixture-source tests) | Not started, as expected |

`src/sources/` is about 1,490 lines, is under the strict tsconfig, and **nothing in the app imports it yet**
(`docs/ARCHITECTURE.md` §7, `STATUS.md`). The running app still loads domain JSON directly.

### C.3 Discrepancies found (reported, not silently fixed)

| # | Where | Discrepancy |
| --- | --- | --- |
| 1 | `public/roadmap/index.html` | Says Phases 2 and 3 are **"In progress"** and is dated 2026-10-15. `STATUS.md` lists serialized units, revision capture and incoming-quality hold as *Proposed* and shows no Phase 2 work. It also predates M0-M2 and does not mention source integration. The public page overstates progress. **Resolved 2026-10-20:** the page was rewritten from this plan and `STATUS.md` (releases 0.1.0, 0.1.x, 0.2.0, 0.3.0; pilot language removed). |
| 2 | `docs/PERFORMANCE.md` | "`npm test` (72 tests ...)" in the Phase 0 section. Current suite is 252 (237 + 15 expected-fail). Stale. **Resolved 2026-10-21:** marked historical; release figures (354 = 339 + 15 expected-fail) added in a dated section. |
| 3 | `README.md` "Connecting real data" | Describes feeding domain events straight to `FactoryReplay`. It predates the `src/sources` boundary and Rev3, and does not mention either. README also has no license, no demo link, no screenshots, no status section. **Resolved:** README rewritten for 0.1.0 (status section, demo link, screenshots, license). |
| 4 | Rev3 §8 M0 vs M7, and the header of `tests/legacy/state.ts` | Three different deletion triggers ("once M3a has merged"; M7; "after M3a has merged and M7 closes"). **Resolved by Amendment A2:** the legacy reducer is retained through M4 and removed before the 0.2.0 tag on stated evidence. The file header still carries the old wording; correcting that comment is part of the M3a PR (not done here: this task is documentation only). |
| 5 | `docs/SOURCE_INTEGRATION_PLAN.md`, `_REV2.md` | Superseded revisions sit beside the live plan with no marker. A new reader cannot tell which governs. **Resolved 2026-10-21:** archive banners added; `docs/README.md` index lists them as archived. |
| 6 | `STATUS.md` header | Dated "as of the Phase 1 equipment and changeover slice" but also contains M1/M2 rows. Header should state a date and commit. **Resolved 2026-10-21.** |
| 7 | `deploy/*`, local `SKILL.md` | `deploy/apache-factoryflow.conf` and `deploy/ROLLBACK_AND_SMOKE.md` reference the owner's personal domain/VPS layout. `SKILL.md` (private hosting notes) is gitignored and untracked, which is correct, but must stay out of the public repo. **Resolved 2026-10-21:** `deploy/` uses placeholders; history not rewritten (no secrets found). |

### C.4 Known limitations that matter for a public release

- **No intelligence on dispatch or lead time**: customer orders carry `dueDate`, but nothing computes on-time
  dispatch, lead time or lateness. (`grep` finds no such analytics; the only `leadTime` use is BOM supplier lead time.)
- **No quality analytics beyond first-pass yield**: inspections record `scrapQuantity` and `defects: DefectCount[]`
  (`types.ts`), but no view aggregates them.
- **Bottleneck is a flag, not an explanation** (largest queued standard minutes per station).
- **No unit-level traceability** (serial units are Phase 2, schema change).
- **No workforce, skills, finite-capacity scheduling or scenarios** (Phases 4 and 5, large domain additions).
- **Integration is built but unused**: M0-M2 deliver no user-visible behavior yet.
- **No UI/3D automated tests**; app code outside `manufacturing/`, scripts, tests, examples and `sources/` is not strict-typed; no lint/format config.
- **Production bundle ~650 kB (about 709 kB after M1/M2 per `PERFORMANCE.md`), Three.js loaded eagerly**; initial load is the only noticeable slowdown.
- ~~No LICENSE file~~ **Resolved 2026-10-21:** Apache-2.0 `LICENSE` added and `package.json` `license` set.

---

## D. Target reference architecture

The layering already exists; the target adds the integration boundary on the data path and an explicit
optional external platform to its left. Dashed pieces are optional.

```
 ┌── optional, outside the repo's runtime ──┐
 │ Databricks / Delta / Unity Catalog views │  (H)  curated tables exported or fetched by a script
 └───────────────────┬──────────────────────┘
                     │ files (NDJSON/JSON); never from the browser
 ┌───────────────────┴───────────┐   ┌────────────────────────────────────────────┐
 │ Source (pick one at load)     │   │ src/sources/  (strict TS, no business rules)│
 │  • simulation (default demo)  │──▶│  adapter: validate, normalize, identity,    │
 │  • MES-like fixture (M6a)     │   │           provenance  ──▶ CanonicalInput   │
 │  • exported curated tables(H) │   │  ingest (M3b): dedupe, order, dry-run on    │
 └───────────────────────────────┘   │           shadow state, quarantine          │
                                     │           ──▶ candidate event log           │
                                     └──────────────────────┬─────────────────────┘
                                                            │ validated, ordered FactoryEvents
                                     ┌──────────────────────▼─────────────────────┐
                                     │ src/manufacturing/  reducer (atomic, M3a)   │
                                     │ FactoryReplay  ◀── SimulationController     │
                                     │                     (the ONE clock)         │
                                     └──────────────────────┬─────────────────────┘
                                         OperationalView (M5, transitional)
                         ┌──────────────────────────────────┼───────────────────────┐
                         ▼                                  ▼                       ▼
                 src/analytics/                       src/ui/ (2D)           src/graphics/ (3D)
          KPIs, dispatch, quality, bottleneck   Dashboard + Operations Explorer   investigates the same
          explanations, traceability queries    (complete without 3D)             analytics via selection
```

### Boundary rules

| Boundary | Rule |
| --- | --- |
| Source ↔ ingest | Adapters never apply business rules or choose between conflicting records. Ingest never guesses order or winners (Rev3 §7.1). |
| Ingest ↔ reducer | The reducer stays strict. Rejections are quarantined with provenance, never relaxed (Rev3 D6). |
| Reducer ↔ analytics | Analytics reads a `ReportingSnapshot`/`OperationalView`; it never mutates and never sees provenance. |
| Analytics ↔ 3D | 3D asks analytics/`mapping.ts` what to show; it computes no business numbers. |
| Platform ↔ domain | Nothing under `src/manufacturing/` or `src/analytics/` may import a platform SDK. Databricks code lives outside `src/`, e.g. `integrations/databricks/` (§H). |

### Where distributed processing does and does not belong

Set-based work (deduplication, type/unit normalization, joins, data-quality expectations, late-record flags)
is a good fit for Spark. **Event ordering with stateful validity (the reducer dry-run), reconciliation and
reprojection are sequential and stay in the TypeScript engine.** Do not port the engine to PySpark absent a
measured need (the whole 4,651-event replay is about 53 ms in Node, `PERFORMANCE.md`).

### Optional external platform

Databricks is a *producer of source files* in the first reference. Other platforms would implement the same
contract later; nothing is built for them now (§I).

---

## E. Product capability roadmap

### E.1 Classification

"Existing" works today. "Incremental" needs new analytics and UI over data and events the domain already
carries (no schema bump). "New domain" needs new entities/events, a `SCHEMA_VERSION` bump and a fixture update.

| # | Capability | Business question | Data needed | Today | Class | Value | Cost | Release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | **Dispatch and lead-time analysis** | Which customer orders are late or past due, and where did the time go (for work orders)? | `CustomerOrder.dueDate`, shipments, WO timeline (wait vs processing vs hold) | Dates exist; no analytics | Incremental | High | M (two parts, S1a/S1b) | **0.1.0** |
| P2 | **Quality, scrap and rework analysis** | Where and why do we lose units? | `QualityInspection.scrapQuantity`, `defects`, rework operations, station/product | Only first-pass yield | Incremental | High | S-M | **0.1** |
| P3 | **Bottleneck explanation** | Why is this work center the constraint, and what is it waiting on? | work-center queues, equipment waits, changeover minutes, downtime, shift calendar | Candidate flag + columns | Incremental | High | M | **0.1** |
| P4 | **Material shortage impact** | Which orders are blocked by which shortage, and when does supply arrive? | blocked orders, `MaterialReservation`, PO `promisedDeliveryAt`, inventory | `shortageBlocked` KPI only (an Inventory tab now shows stock by location and item); no causal link | Incremental | Med-High | S-M | 0.1.0 if time allows (not a blocker) |
| P5 | **Order and work-order traceability links** | For this customer order, which WOs, materials, inspections, shipment? | existing relationships (`ARCHITECTURE.md` §3) | WO drawer exists; not linked end-to-end | Incremental | Med-High | S | **0.1** |
| P6 | **3D as analytical interface** | Where in the plant is the problem? | P1-P5 outputs mapped via `mapping.ts` | Selection, status colours, queue buffers | Incremental | Med-High | M | **0.1.0** (scoped: analytical link + overlays) |
| P7 | **Work-center utilization and queue visibility** | How loaded is each work center over time? | exists | Implemented (Work Centers tab) | Existing | n/a | n/a | done; add history chart in P3 |
| P8 | **Individual-unit (serial) traceability** | What is the full history of unit X, including retests? | serialized units, per-attempt facts, BOM/routing revision captured on WO | Not modeled | New domain | High | L | unscheduled (first domain extension after 0.2.0) |
| P9 | Incoming quality hold, partial receipts, substitutes | Why is material unavailable though received? | new receipt states and events | Not modeled | New domain | Med | M-L | unscheduled (optional) |
| P10 | Capacity vs load view | Can we meet next week's demand? | routing standard minutes, calendar, equipment | Standard minutes + calendar exist; no demand projection | Incremental, flagged **forecast** | Med | M | unscheduled (S10's work-time estimate is the per-order seed of this) |
| P13 | **Exceptions inbox and investigation trail** | What deserves my attention right now, and how did I get from the symptom to the evidence? | existing analytics outputs (dispatch, shortages, work centers, quality), deep links | Separate tabs; no cross-cutting list or breadcrumb | Incremental | High | M (S7, S8) | **0.1.x** |
| P14 | **Part delivery lead time** | How long does each part really take to arrive, and how reliable is each supplier? | `Material.leadTimeDays`, `PurchaseOrder.createdAt` / `promisedDeliveryAt`, `SupplierReceipt.receivedAt` / `daysLate` / `delayReason` | Standard lead time on master data; no analytics | Incremental | High | S-M (S9) | **0.1.x** |
| P15 | **Work-order ETA with material delay** | When can this work order finish, given that part X is short? | P14, `workCenters` queues, routing standard minutes, shift calendar, open POs (S4) | Not modeled; S4 shows PO cover dates only | Incremental, flagged **forecast** | High | M (S10) | **0.1.x** (after S9) |
| P16 | **Shipping and delivery tracking** | When did finished goods leave, when did they arrive, and did the customer get them by the promised date? | New: shipment lifecycle (delivered event, transit time, delay reason); existing dispatch data | Dispatch only; no delivery, transit or ETA | **New domain** (`SCHEMA_VERSION` bump) | High | M-L (S11, S12) | 0.2.0 (schema change ships alone) |
| P11 | Workforce: availability, skills, assignments, overtime | Is labor the real limit? | staff, skills, shifts, absences, skill requirements on routing steps | Not modeled; deferred by design (Phase 4) | New domain | High (large domain extension) | XL | **post-0.2, optional** |
| P12 | Finite-capacity scheduling, scenario comparison | What if we add a station or shift? | P11 plus scenario isolation | Not modeled (Phase 5) | New domain | High | XL | research only |

Cost key (my judgment, not measured): S = a few days, M = about a week or two, L = several weeks, XL = a project in itself.

### E.2 Opinionated priorities

- **0.1.0 is intelligence on data we already have.** P1 to P5 need no schema change, so they cannot destabilize
  the pinned fixtures, and they directly address the "too much integration, too little intelligence" concern.
- **P8 (serial units) is the first real domain extension** and the best candidate after 0.2.0: it is the traceability story
  the design doc promises and the prerequisite for any order-to-work-order lead-time decomposition (KPI_DEFINITIONS, S1). It needs a
  deliberate `SCHEMA_VERSION` bump and pairs naturally with a second source (a real MES reports unit-level facts).
- **P11/P12 (workforce, scheduling, scenarios) are demoted** from "next phases" to optional research. They
  roughly double the domain (staff, skills, calendars, scheduler, scenario isolation) and do not strengthen
  any release goal that P1-P8 do not. If pursued, do it as a self-contained experiment branch with its own
  design note, after 0.2.0.
- **0.1.0 reports observed facts, not predictions.** No predicted delivery-risk model, no "at risk" flag. Lateness, past-due
  open orders and time-to-due-date are arithmetic over recorded facts. A forecast must be labelled *forecast* when it arrives.
- **The first forecast is deliberately narrow (revised 2026-10-20).** S10 estimates one thing: when a *work order* can finish, as
  `material-ready time + remaining standard work`. It uses recorded inputs (part lead times, open PO dates, routing minutes, the shift calendar), states each
  input beside the result, and makes no customer promise and no "at risk" claim. A full capacity model (P10) is not required for this narrower estimate, but
  S10 must say that it ignores queue contention (it is an *earliest feasible* date, not an expected date) until queue time is added and validated.
- **P16 is the one schema change in this revision** and the only reason the fixtures and hashes move. It ships alone (F.1 rule) and before M6a's
  `expected.json` is finalized, so the second source reports deliveries too.
- **P8 (serial units) follows P14 to P16**, still the first domain extension after the investigation work; it is the prerequisite for the order-to-work-order
  lead-time decomposition that remains deferred.

### E.3 Slice specifications (release 0.1.0)

Each slice: definition first in `KPI_DEFINITIONS.md`, then analytics in `src/analytics/` with unit tests over
a `ReportingSnapshot` (`tests/helpers/snapshot.ts`), then Explorer UI, then 3D link. Acceptance criteria are
measurable against the default dataset (seed `northstar-2026`) or a hand-built fixture.

**S1. Dispatch and lead time (P1)** (two parts so each is a reviewable PR)

Metric semantics are defined, as **proposed / not implemented**, in `KPI_DEFINITIONS.md` ("Proposed, not implemented: dispatch, lead
time and work-order time"), which is authoritative. Summary only:
- Everything is **observed** and on a **dispatch basis**. The model records dispatch, not customer receipt, so nothing in the UI says
  "delivery"; transit time is not reported. For the synthetic manufacturer `dueDate` is treated as **dispatch-by**, a documented
  assumption that another source's adapter must restate. The order-to-work-order link is a **planning link** (`demandLineIds`), not proven
  unit flow, so order lead time is not decomposed into work-order phases (deferred to unit/lot traceability, P8).
- **Names:** Order-to-Final-Dispatch Lead Time (with three exclusive milestone segments summing exactly to it), Dispatch Lateness,
  Past-Due Unshipped Orders, Time to Due Date, **On-Time In-Full Dispatch** (cohorted by due date; unshipped overdue orders stay in the
  denominator; partial dispatch does not satisfy in-full), **Quantity Fill by Due Date** (separate), and optionally a shipment-level
  **On-Time Dispatch Rate**. Cancelled orders are excluded and counted. Empty cohorts are N/A. No predictive risk.
- **Work-order flow time and cycle time**, distinct from order lead time.
- **A. Mutually exclusive categories** for one work order, defined by **eligibility predicates** over reducer state (`PRE_RELEASE`,
  `MATERIAL_BLOCKED`, `HELD_MACHINE_DOWN`, `PROCESSING`, `QUEUE_WAIT`, `OFF_SHIFT`, `POST_PRODUCTION`, `UNCLASSIFIED`), summing exactly to
  elapsed time. `QUEUE_WAIT` requires an open operation waiting to start; `POST_PRODUCTION` requires all operations completed and nothing
  pending, so post-operation time is never counted as queue waiting. Precedence is only a safeguard. Versus **B. overlapping contributing
  conditions**, which are indicative, never summed, never root causes; equipment and backlog are **current-state observations only** in 0.1.0.
- **Reconciliation with the drawer:** the existing step `Wait` and the new `QUEUE_WAIT` are **not** equal in general; they agree only on closed,
  in-shift, unrounded waits (`KPI_DEFINITIONS.md` lists the differences and the valid tests). The drawer is not changed.
- **S1a (orders):** Explorer "Dispatch" tab with the order metrics above and their N/A rules; click an order to see its linked work orders
  (labelled "planned to satisfy"). **S1b (work orders):** the exclusive decomposition and the available conditions in the work-order drawer.
- Accept (S1a): every figure recomputes in a unit test from a hand-built snapshot; tests for cancelled orders, partial dispatches, an
  order dispatched on the due instant, an unshipped overdue order staying in the denominator, a partial dispatch failing "in full" but counting in
  Quantity Fill, an empty cohort giving N/A, and milestone segments summing exactly to lead time; no schema, fixture or hash change.
- Accept (S1b): for every work order of the default dataset the A categories sum exactly to `end - createdAt` and `UNCLASSIFIED` is zero or each
  non-zero case is explained; the predicates are mutually exclusive at every instant (no tie-break used); the reconciliation tests in
  `KPI_DEFINITIONS.md` pass (closed waits exact, drawer display within 0.5 minute per step); a fixture with a post-operation gap shows it as
  `POST_PRODUCTION`, not `QUEUE_WAIT`; a fixture with rework shows the rework wait as `QUEUE_WAIT`; a fixture with overlapping material block history and a
  later machine-down shows the categories staying exclusive; conditions B carry the "may overlap, not additive" wording and equipment/backlog show
  "current state at <asOf>", never as durations.

**S2. Quality and scrap (P2)**
- Definitions: scrap rate, rework rate, FPY by product and station, defect Pareto by type.
- Accept: totals reconcile to `scrappedQuantity` on orders and to inspection records (tested); FPY by product
  aggregates back to the existing dashboard FPY; sparse-data N/A rules documented.

**S3. Bottleneck explanation (P3)**
- Definition: for the flagged work center, show **contributing conditions** (S1 "B": capacity as queued minutes per station, equipment
  unavailable, changeover minutes, station downtime, off shift, material shortage upstream) as **overlapping, indicative** indicators.
  They are not a partition, are never summed into a percentage of elapsed time, and are not a root-cause claim. Each is sourced from
  existing analytics or from the S1b conditions; conditions that are current-state only are labelled so.
- UI: a "Why" panel on the Work Centers tab. Equipment availability and backlog appear as **current-state observations**; there is no queue-over-time chart in 0.1.0 (it would reconstruct history, L11).
- Accept: a constructed fixture with a known cause (all units of an equipment kind held) shows that condition; a fixture where two
  conditions overlap shows both with the non-additive note; wording tests/review confirm "indicative", not "root cause".

**S4. Material shortage impact (P4)**
- Accept: each blocked order lists the short material, shortfall quantity and the earliest open PO
  `promisedDeliveryAt` that would cover it (or "no supply on order"); reconciles to the `shortageBlocked` KPI count.

**S5/S6. Traceability links and 3D investigation (P5, P6)** *(S5 = the navigation and deep-link bullet below, implemented; S6 = the 3D bullets, implemented as specified in `KPI_DEFINITIONS.md` "3D overlays")*
- Customer order → WOs → materials/inspections → shipment navigation in the drawer; deep-linkable URL state. *Implemented as: a customer-order drawer (lines, allocations, shipments, planned work orders) opened from the Dispatch and Material Shortages tabs and from the work-order drawer; planned work orders link back; Back returns to the previous entity; URLs `#/explorer/orders/<WO>` and `#/explorer/dispatch/<CO>`. The order-to-work-order link is a planning link; a work order's materials and inspections stay in its own drawer.*
- 3D: an overlay mode selector (status / queue / utilization / blocked-by-shortage) driven by the same
  selectors as the tabs, and click-to-drawer in both directions (Explorer row highlights its object).
- No-3D mode: Explorer and dashboard fully usable with the scene not loaded (see §F.5 and §G.1).
- Accept: for each overlay, a test that the set of highlighted objects equals the set computed by the
  matching analytics function; cross-highlight covered by `mapping.ts` unit tests. Rendering itself remains
  manually verified (§G.4 smoke list).

### E.4 Slice specifications (release 0.1.x Investigation and 0.2.0 shipping; proposed, none implemented)

Same method as E.3: definition first in `KPI_DEFINITIONS.md` (marked "Proposed, not implemented" until built), then analytics with unit tests over a
`ReportingSnapshot`, then UI, then the 3D link. S7 to S10 need **no schema change**.

**S7. Exceptions inbox (P13)**
- A single ranked list on the dashboard (and an Explorer tab) of *currently observed* conditions that deserve attention, assembled from analytics that already exist:
  past-due unshipped customer orders (`dispatch`), work orders blocked by material (`materialShortages`), the bottleneck candidate and queues over a stated
  threshold (`workCenters`, `bottleneck`), stations down (`workCenters`), and quality outliers (`quality`, only where the sample size rule is met).
- Each row: a **type**, the **entity** (deep link), a **one-line evidence statement made only of recorded numbers** ("blocked 3 d 4 h; short PLC-300 by 12; next PO due 2026-10-24"),
  and the **threshold** that put it on the list. Thresholds are named constants shown in the UI, not hidden heuristics.
- Not predictions: no "at risk" rows. A row appears or disappears only because a recorded state changed; ranking is by a documented, simple key (type priority, then age), not a score.
- Accept: every row's entity set equals the set the owning tab already counts (tested per type, so the inbox cannot disagree with its source tab); a hand-built fixture
  produces the expected rows and order; an empty plant shows an explicit "nothing to report", not a blank; the evidence text is generated from fields, with a test that no
  number appears that is not in the source record.

**S8. Investigation trail and time comparison (P13)**
- A breadcrumb that records the chain of entities the user opened (inbox row → customer order → work order → work center → material → 3D object) with Back and jump-to-any-step. It extends the
  existing route parser and Back behaviour; the URL still records what is on screen, not simulated time.
- **Compare windows:** pick two simulated-time windows (default: current shift against the previous shift) and show the change in the headline observed figures (good units, queue
  depth per work center, blocked orders, downtime minutes, dispatches). Differences are arithmetic over the same definitions; no significance claims.
- Accept: route round-trip tests for trails; a comparison of identical windows is all zeros; windows that straddle the simulation start or end are clamped and say so; each compared figure equals
  the single-window figure computed independently (tested).

**S9. Part delivery lead time (P14)**: observed and standard, per part and per supplier. *Definitions belong in `KPI_DEFINITIONS.md` before code.*
- **Standard lead time** (master data, not observed): `Material.leadTimeDays`, today copied from the supplier. Shown labelled "standard".
- **Observed lead time of a delivery**: calendar days from `PurchaseOrder.createdAt` to the `SupplierReceipt.receivedAt` that first receives that PO line. Units are days (fractions kept
  internally), because the plan's other durations are minutes but supplier lead times are quoted in days; the conversion is one constant, tested. Short shipments: the *first* receipt counts as the delivery, the remainder is
  reported as "short-shipped" and not averaged in. A PO line with no receipt yet is **open** and excluded from observed statistics but shown as "waiting N days of M standard".
- **Per material** and **per supplier**: deliveries count, observed mean and P50/P90, standard, **delta to standard**, observed on-time rate (receipts with `daysLate = 0` ÷ receipts), mean days late, and the recorded `DelayReason` mix.
  Percentiles need a **minimum sample** (documented constant, default 5); below it show the count and "not enough data", never a statistic. A material with no receipt shows "no deliveries observed".
- **Expected lead time basis (an explicit choice, never implicit):** `STANDARD` (default) or `OBSERVED_P50` / `OBSERVED_P90` when the sample rule is met. Every consumer (S10) states which basis it used.
- Visuals: a per-material strip showing standard against observed P50/P90 with individual deliveries as dots; a supplier reliability table; open PO lines as bars from created date to promised date with "today" marked. Data only; no new charting library (§F.6).
- Accept: figures recompute from a hand-built snapshot (on-time, late, short-shipped, open, partial first receipt, sample below the minimum, material with no PO); supplier-level figures equal the weighted
  aggregation of their materials (no averaging of averages); the seeded dataset's observed on-time rate per supplier is within sampling noise of the master `onTimeRate` and any gap is explained in the doc, not tuned away; no schema, fixture or hash change.

**S10. Work-order ETA with material delay (P15)**: *forecast*, always labelled.
- **Definition (proposed):** `ETA = materialReadyAt + remainingWork`, where:
  - `materialReadyAt` is *now* if the order is not short of material; otherwise the **latest** over its short materials of the earliest of: (a) the promised date of the open PO lines that cover the shortfall (the S4 cover date), plus the observed mean days late for
    that supplier when the basis is observed; or (b) when **no supply is on order**, `now + expected lead time` of that material (the stated basis from S9), i.e. the earliest a new order could arrive. Materials are waited for in parallel, so the wait is the maximum, not the sum.
  - `remainingWork` is the sum of the remaining routing steps' standard minutes plus changeover where known, laid out on the shift calendar starting at `materialReadyAt` (so off-shift time is included, not ignored).
  - Example from the owner: a part missing with a 2-day lead time and 6 hours of work gives an ETA of about 2 days plus 6 working hours, rolled forward over the shift calendar.
- **What it is not:** it ignores queueing behind other orders and resource contention, so it is an **earliest feasible** date. It does not allocate scarce stock or supply between competing orders (the same limitation as S4); where several orders are short of one
  material the UI says so. It is not a customer promise, not an "at risk" flag, and shows no confidence band until enough history exists to compute one honestly.
- **Display:** the order's bar split into *waiting for parts* / *work* with the ETA marked, the basis and inputs listed beside it ("lead time basis: standard 2 d; covering PO PO-0042 promised 2026-10-24; remaining routing 6 h 20 m"), and a distinct visual style (hatched/dashed)
  from observed bars. The same order's *observed* segments, once recorded, replace the estimate; the estimate is retained for comparison ("estimated vs. actual").
- **Evaluating it:** a backtest table over the seeded dataset (ETA computed at the moment each order was blocked, compared with actual release/completion). Reported honestly, including that it is biased early because queueing is ignored. If the error is large, the doc says so; the estimate is not tuned to look good.
- Accept: hand-built fixtures for no shortage, shortage with covering PO, partial cover, no supply on order (uses lead time), two short materials (maximum), shortage ending mid-shift and off-shift roll-forward; labelled "forecast" in every UI surface and in the evidence text; the S7 inbox may show the ETA only as a labelled estimate beside an observed row, never as its own row; no schema change.

**S11. Shipment lifecycle in the domain (P16): the schema change**
- **New facts** (proposed; to be confirmed in a design note before code): an event for delivery (`SHIPMENT_DELIVERED`, with `deliveredAt`), carrier transit-time master data per carrier and region (so transit times differ and are explainable), an optional recorded delay reason (reusing the vocabulary style of `DelayReason`),
  and an explicit **shipment status** (`DISPATCHED`, `DELIVERED`). Delivery is a recorded fact, not an inference; a shipment with no delivery event is "in transit" or "delivery not reported", depending on the source's declared capability (design §12.3).
- **Contracts:** `SCHEMA_VERSION` bump (`1.4.0`), canonical fixture and hashes updated deliberately in a PR that contains nothing else, migration note, `REDUCER_RULES.md` rows for the new event, generator and wire-format (`src/sources/simulation/`) updated together, contract tests.
- **Reducer rules** to define: delivery cannot precede dispatch; a shipment is delivered at most once; delivery of an unknown shipment is rejected (the reducer stays strict, Rev3 D6); customer-order status is *not* changed by delivery (shipped ≠ delivered).
- Accept: round trip through the wire format is exact; validation and determinism checks pass; the old dataset is still readable through a documented migration or the fixture is regenerated and the old hash recorded in the migration note.

**S12. Shipping tracking and delivery visuals (P16)**
- Explorer "Shipping" tab. Metrics (definitions first): **Dispatch-to-Delivery Transit Time** (observed, per carrier and region), **Delivered On Time** (delivery on or before the customer promise date; defined only for orders with a recorded promise date, with the
  synthetic `dueDate` documented as a *delivery-by* assumption here, distinct from the dispatch-by assumption of S1), **In Transit** now (count and age), **Delivery Delay** (days past promise), and the order's end-to-end timeline: ordered → built → dispatched → delivered, extending S1a's milestone segments by a fourth, observed segment.
- Visuals: a lane per shipment (dispatched → delivered) against the promised date with today marked, late deliveries highlighted; a transit-time distribution per carrier; an "In transit" list sorted by age. A map or animated marker view is **optional and last**: it adds no new
  information beyond the lane view and does not block the slice.
- The customer-order drawer gains the delivery state of each shipment; S7's inbox gains "in transit longer than the carrier's observed P90" (observed, with threshold shown) and "delivered late".
- 3D: shipping bays show in-transit shipments awaiting pickup or departure as markers only if the event data supports it; no invented movement between the plant and the customer.
- Accept: figures recompute from a hand-built snapshot (delivered on time, late, in transit, delivered on the promise instant, shipment with two lines, order shipped in two shipments); On-Time In-Full Dispatch (S1a) is unchanged; "delivered" never appears for a dispatch-only source (capability-aware wording).

---

## F. Technical development roadmap

### F.1 Principle

Revision 3's technical intent and acceptance criteria are kept (with Amendments A1 and A2). Releases (§G) decide what is
*promised* publicly; they do not decide what may be built. Two lanes can run in parallel because they touch different files:

| Lane | Work | Touches | Rule |
| --- | --- | --- | --- |
| **Intelligence** | S1a, S1b, S2, S3, S5/S6, optionally S4 | `src/analytics/`, `src/ui/`, `src/graphics/`, `KPI_DEFINITIONS.md` | Never changes event shapes, reducer rules or pinned fixtures |
| **Integration** | M3a, M3b-core, M4, M5, M6a | `src/manufacturing/state.ts`, `src/sources/`, `src/simulation/`, tests | Pinned-contract changes (reducer, fixtures, hashes) ship alone, never bundled with a lane-1 PR |
| **Domain** | S11 (shipment lifecycle) | `src/manufacturing/`, `src/sources/simulation/`, fixtures, `REDUCER_RULES.md` | A `SCHEMA_VERSION` bump with migration note; ships alone; S12 (Intelligence lane) follows it. S7 to S10 belong to the Intelligence lane and must not need this lane |
| **Release** | truth alignment, legal and asset review, README, hosting, screenshots | docs, repo metadata, `deploy/` | Docs-only unless stated |

Rev3 dependencies hold: M3b needs M1 and M3a; M4 needs M2 and M3b-core; M5 needs M4; M6a needs M4 and M5. S1 to S3 depend on nothing
in the integration lane. M6a's `expected.json` should cover the S1 to S3 results that exist when it is authored.

### F.2 Suggested order (dependencies, not release gates)

| Step | Work | Source | Needs | Targets |
| --- | --- | --- | --- | --- |
| 0 | **Truth alignment** (C.3 items 1-3, 5, 6; docs only) | new | none | 0.1.0 |
| 1 | **S1a** lead time, lateness, past-due unshipped, on-time in-full dispatch *(implemented)* | §E.3, KPI_DEFINITIONS (proposed) | none | 0.1.0 |
| 2 | **S1b** work-order decomposition (A) and conditions (B) *(implemented)* | same | S1a not required, shares helpers | 0.1.0 |
| 3 | **S2** quality and scrap *(implemented)* | §E.3 | none | 0.1.0 |
| 4 | **S3** bottleneck explanation *(implemented)* | §E.3 | S1b helpers | 0.1.0 |
| 5 | **S5** order-to-work-order navigation and deep links *(implemented)*; **S6** analytical Explorer/3D link and overlays *(implemented; rendering not yet verified in a WebGL browser)* | §E.3 | S1 to S3 | 0.1.0 |
| 6 | Legal/asset review, README, screenshots, hosting, **tag 0.1.0** *(done 2026-10-21)* | §G.1 | 1-5 | 0.1.0 |
| 7 | **S7** exceptions inbox | §E.4 | S1 to S4 (done) | 0.1.x |
| 8 | **S8** investigation trail and time comparison | §E.4 | S5, S7 | 0.1.x |
| 9 | **S9** part delivery lead time (per part and supplier; defines the lead-time basis) | §E.4 | S4 (done) | 0.1.x |
| 10 | **S10** work-order ETA with material delay (*forecast*, labelled) | §E.4 | S9, S4 | 0.1.x |
| 11 | **S11** shipment lifecycle in the domain (schema bump; ships alone) | §E.4 | none; do before M6a | 0.2.0 |
| 12 | **S12** shipping tracking and delivery visuals | §E.4 | S11 | 0.2.0 |
| A | **M3a** atomic reducer *(may land at any point; independent of steps 1-12)* | Rev3 §8, §7.6 | M0 (done) | 0.2.0 |
| B | **M3b-core** batch projection (Rev3 §7.4a) | Rev3 §8 M3b, A1, A2 | M1, M3a | 0.2.0 |
| C | **M4** app boots through the boundary | Rev3 §8 M4 | M2, M3b-core | 0.2.0 |
| D | **M5** OperationalView, import and module-graph boundaries | Rev3 §8 M5, A1 | M4 | 0.2.0 |
| E | **M6a** MES-like source, `expected.json`, messy variant | Rev3 §8 M6a, §10 | M4, M5 | 0.2.0 |
| F | 0.2.0 bookkeeping, legacy-reducer removal, adapter how-to, **tag 0.2.0** | Rev3 M7 (A1, A2) | A-E | 0.2.0 |
| G | Databricks reference (§H) | §H | 0.2.0 | 0.3.0 |

Steps 7 to 10 (the investigation sequence) follow tagging 0.1.0 and need no schema change; S11 is sequenced before M6a so the second source reports deliveries (otherwise
`expected.json` would have to be revised). Steps A to E may be interleaved with 1 to 5 or done first. If M3a lands before 0.1.0 it is marked complete in `STATUS.md` and not
repeated for 0.2.0.

### F.3 Milestone notes (constraints on top of Revision 3)

- **M3a** (atomic reducer). Keep all eight acceptance criteria. The 15 `it.fails` entries must flip. Fixture hash `6ed76381` and log hash
  `1b408e8e` stay pinned. **The frozen reducer in `tests/legacy/` is kept** (Amendment A2) and its header comment is corrected in the
  same PR. One decision: `PRODUCTION_ORDER_CREATED` currently accepts duplicate operation ids within one event (M0 outcome). Keep parity
  in M3a; change it, if at all, in a separate reviewed behavior change that also ends the legacy oracle's usefulness (A2 removal trigger).
- **M3b-core.** The contract is Revision 3 §7.4a: a deterministic finite-batch projection with exact input accounting, not a published log.
  Summary in §F.4.
- **M4.** Keep KPI parity at three seek points, zero quarantine and zero error issues for the simulation, the capability gate, and the load
  budget (D7: added one-time load work at most about 300 ms; M2 measured about 136 ms). The default source stays the simulation (D8).
  A source is selected by a documented flag or build option, not a UI feature.
- **M6a.** Keep the hand-authored `expected.json` and the hard rule: if any edit to `analytics/`, `ui/` or `graphics/` is needed to
  accommodate source-specific behavior, the boundary is cosmetic and the milestone fails. Messy variant pins the matrix rows that apply to
  event sources, with rows 7, 22 and 24 read per §7.4a.

### F.4 M3b-core contract, in one paragraph (authoritative text: Revision 3 §7.4a)

M3b-core takes a **closed** set of canonical inputs (plus persisted resolutions and hints, identity-map version, master and initial
state) and returns an **immutable `BatchProjection`**: an ordered, contiguous, validated accepted log; quarantine per logical identity; unprojected
observations; one disposition per physical input; and accounting that must balance (physical: inputs = accepted + duplicate-ignored +
superseded + quarantined + unprojected; logical: identities = accepted + quarantined; projection: replayed `lastSequence` advances by exactly
the accepted count). Grouping, conflicts (fail closed, versions only when the source declares them) and ordering (ordinals, fixed order for
independent ties, `AMBIGUOUS_ORDER` quarantine) are Revision 3's rules unchanged; validity comes only from the atomic reducer on a
shadow state. Reprocessing or permuting the batch yields a deep-equal result; a different batch yields a different projection with no
stability, prefix or pending-diff promise. The projection is a candidate, never called "published". M3b-full later wraps it with
published logs, pending changes, explicit `reproject` and incremental reconciliation; §7.4a lists the design constraints that keep that possible.

### F.5 Accepted scope changes to Revision 3 (R1 to R8, now amended into the docs)

| # | Change | Where applied |
| --- | --- | --- |
| R1 | M3b split: **M3b-core** (release 0.2.0), **M3b-full** unscheduled | Rev3 A1, A2, §7.4a |
| R2 | M5 keeps port, import-boundary and module-graph tests; drops the ratchet allowlist unless needed | Rev3 A1 |
| R3 | M6b unscheduled and optional | Rev3 A1 |
| R4 | M7 split: bookkeeping with 0.2.0, typed rejection codes and reconciliation guidance later | Rev3 A1 |
| R5 | D10: four ordinal types kept, behavior for `none`, `posting`, `causal`; `adapter_derived` and D11 deferred | Rev3 A1 |
| R6 | Capabilities used for the boot gate; counts only in the UI, no data-health screen | Rev3 A1 (already deferred there) |
| R7 | Declarative mapping is small, file-based, closed vocabulary, optional (below) | this plan |
| R8 | Design doc Phases 4-6 re-scoped | `FACTORYFLOW_DESIGN.md` |
| A2 | Release restructure; M3b-core contract; legacy reducer retained through M4 | Rev3 A2, §G |

**Declarative mapping (optional, unscheduled).** One versioned JSON file per source (`mappingVersion`, `sourceId`, per-table field renames,
unit conversions from a closed list, status-code tables, timestamp format and zone, id-derivation template, ordinal declaration), validated
with the existing `zod/mini` primitives, producing `MappingIssue`s with paths. Closed vocabulary only: no expressions or scripting. Anything it
cannot express stays a hand-written adapter, as in M6a. It becomes necessary only if the Databricks export (0.3.0) cannot reuse the existing
wire-contract adapter; otherwise do not build it. No UI editor, no multi-tenant mapping store, no general ETL.

### F.6 New dependencies and abstractions

None required for 0.1.0, 0.2.0 or 0.3.0. `zod` is already added (M1). Declined: ESLint/Prettier (typecheck and tests suffice; revisit if
outside contributors arrive), Playwright (manual smoke list instead; revisit if demo regressions recur), a charting library (the existing
hand-built chart is sufficient for a few more charts), any backend or database, any Databricks SDK.

---

## G. Release roadmap: 0.1.0, 0.2.0, 0.3.0

### G.0 Definitions and rules

| Term | Meaning | Evidence |
| --- | --- | --- |
| **Milestone completed** | Its acceptance criteria are met, merged, and an outcome note is recorded (as for M0 to M2 in Revision 3) | Tests green on `main`, outcome note |
| **Capability implemented** | The behavior exists in the repository, is tested, and its `STATUS.md` row says *Implemented* with a pointer | `STATUS.md` row, test |
| **Release ready for publication** | The release's definition of done (§J) is satisfied on the release commit, including docs, legal and hosting items that no milestone covers | §J checklist, tag |

- A capability or milestone assigned to a later release **may be implemented earlier**. A release lists what it *promises publicly*, not what is
  *forbidden* on `main`. Early work that is not release-quality is hidden or labelled, never advertised.
- Release numbers are labels for coherent states, not development phases or gates. The Intelligence and Integration lanes (§F.1) run in parallel.
- A milestone completed before a release is marked complete in `STATUS.md` and Revision 3 and is not repeated for a later release.
- The README and release notes may only claim capabilities that `STATUS.md` marks *Implemented*, and must separate what works from what is planned.

### G.0.1 Maturity levels (what each release does and does not establish)

| Level | Established by | What may be claimed | What may not be claimed |
| --- | --- | --- | --- |
| **L0 Synthetic demonstration** | 0.1.0 | An interactive manufacturing-intelligence application on deterministic synthetic data; tested domain model and analytics | Compatibility with any real system; that the analytics are decoupled from the simulation |
| **L1 Independent-source integration proof** | 0.2.0 | The same analytics, UI and 3D run unchanged from a second, independently structured, hand-authored fixture, with provenance, validation, deterministic ordering and quarantine | Connection to a real MES or ERP; behavior at real volumes or latencies; handling of every real-world data defect |
| **L2 Databricks reference integration** | 0.3.0 | A reproducible example of lakehouse-prepared synthetic data feeding FactoryFlow, with reconciliation | That FactoryFlow is production ready, scales to production volumes, or has been deployed anywhere |
| **L3 Production enterprise deployment** | **Not provided** | Nothing | Anything. A real deployment needs security (authentication, authorization, secrets), reliability and operations (availability, monitoring, backup), data governance, volume and performance validation, domain validation with the plant's actual processes, and deployment engineering, all outside the scope of every release here |

FactoryFlow is an **engineering reference implementation**. It is not a production-certified MES, ERP, scheduler or manufacturing-control system, and
no document, release note or demo text may say or imply otherwise. The README states this plainly (§J, 0.1.0).

### G.1 Release 0.1.0: Public Preview

1. **Purpose and audience.** A polished, accessible, open-source manufacturing intelligence application on synthetic data, useful and technically
   interesting before any external integration exists. Audience: first-time visitors, manufacturing and analytics engineers, contributors.
2. **Required capabilities.**
   - Public GitHub repository; Apache License 2.0 (subject to the ownership, dependency and asset review); hosted demo without login; reproducible local setup.
   - Existing deterministic simulation, domain model, dashboard and 3D visualization (as in `STATUS.md`).
   - **S1a/S1b** dispatch and lead-time analytics, **S2** quality and scrap analytics, **S3** bottleneck explanations (§E.3), on observed facts only.
   - Basic customer-order to work-order navigation (labelled as a planning link) and a clear analytical connection between the Operations Explorer and the
     3D factory (select in either, see it in both; at least the status, queue and blocked overlays).
   - Honest documentation: README, architecture overview, known limitations, screenshots; the working simulation-based application clearly separated from planned integrations.
   - Passing tests, typechecks, data validation and production build.
   - Recommended, not blocking: S4 shortage impact (implemented); lazy-loading the 3D scene so the dashboard and Explorer paint without Three.js.
3. **Required technical milestones.** None from Revision 3. **M3b, M4, M5 and M6a are not release blockers.** M3a and others may land earlier if reached.
4. **Dependencies.** Existing code and fixtures only (no schema change). Legal, asset and history review (§J). A hosting target.
5. **Non-goals.** Source-independent ingestion claims; Databricks; predictive delivery risk or any "at risk" indicator; serial-unit traceability; workforce,
   skills, scheduling or scenarios; automated UI tests; any claim of real-system compatibility.
6. **Acceptance criteria.** S1a, S1b, S2, S3 acceptance as specified in §E.3 and `KPI_DEFINITIONS.md`; every added number traceable to events and state and
   defined before it was built; navigation order to work order to work center to 3D object works in both directions (manual smoke, recorded); the Explorer and
   dashboard are fully usable without relying on the 3D scene; the synthetic-data label is visible on every view; fixture hash `6ed76381` and log hash `1b408e8e`
   unchanged (or changed deliberately with a `SCHEMA_VERSION` bump and migration note); README claims match `STATUS.md`.
7. **Demonstration scenario (about two minutes).** Open the hosted demo, no login. In the Dispatch tab find a late or past-due customer order and read its lead
   time and milestone segments. Open its linked work orders (shown as "planned to satisfy"). In a work order's drawer read the exclusive time breakdown and the
   contributing conditions, noting the "may overlap" wording. Follow the work center to the Work Centers tab, read the bottleneck panel, and select the same work
   center in the 3D plant, seeing its queue and overlay. Then clone the repository and run the same thing locally with `npm install && npm run dev`.
8. **Definition of done.** §J, release 0.1.0.

### G.1a Release 0.1.x: Investigation (proposed 2026-10-20)

1. **Purpose and audience.** Turn the 0.1.0 analytics into an investigation workflow, and add the first labelled forecast. Audience: plant-manager-style users and engineers evaluating the product idea.
2. **Required capabilities.** S7 exceptions inbox, S8 trail and time comparison, S9 part lead time, S10 work-order ETA with material delay (labelled *forecast*, earliest-feasible, basis shown). A `0.1.1`, `0.1.2`, … sequence is acceptable (slices may ship as they land); each is a tag with a `STATUS.md` update, not a promise of the whole list.
3. **Dependencies.** 0.1.0 tagged (or at least S1 to S6 implemented). No schema change, no fixture or hash change: **if any slice here needs one, it is out of this release** and moves to 0.2.0 with S11.
4. **Non-goals.** Delivery or transit data (S11/S12), "at risk" flags or probabilities, confidence bands, customer promise dates generated by the app, queue-contention modelling, any claim that the ETA is accurate beyond its backtest, and everything 0.1.0 excludes that is not listed above.
5. **Acceptance.** E.4 acceptance criteria for S7 to S10; the inbox agrees with the tabs it summarises; every ETA shows its basis and inputs and the word "forecast"; the backtest table is published in the docs with its biases; hashes unchanged.
6. **Demonstration scenario (about two minutes).** Open the inbox, pick a blocked work order short of a part, see the short part's standard and observed lead time, open the covering PO, read the labelled ETA and its inputs, follow the trail back to the customer order and the 3D rack, then compare this shift with the last.
7. **Definition of done.** Release 0.1.x checklist in §J.1a.

### G.2 Release 0.2.0: Source Independence

1. **Purpose and audience.** Show that the manufacturing intelligence is not coupled to the synthetic simulation: the same analytics, UI and 3D run from independently
   structured data. Audience: engineers evaluating the architecture, integration and data-platform engineers.
2. **Required capabilities.** Source identity, provenance, validation, deterministic ordering, quarantine and exact input accounting for a finite batch (Revision 3
   §7.4a); the app booting from the simulation **through** the boundary and from an independently authored MES-like fixture; reproducible parity and correctness tests; a
   documented adapter contract and a short how-to for writing a source; visible counts (accepted, quarantined, unprojected, adapter rejections) and the source name.
3. **Required technical milestones.** **M3a** atomic reducer (marked complete, not repeated, if done earlier); **M3b-core**; **M4**; **M5** (trimmed per A1); **M6a**
   (including the messy variant); 0.2.0 bookkeeping from M7 (STATUS, PERFORMANCE results against the D7 budgets); removal of `tests/legacy/` on the Amendment A2 evidence.
4. **Dependencies.** M3a needs M0 (done). M3b-core needs M1 (done) and M3a. M4 needs M2 (done) and M3b-core. M5 needs M4. M6a needs M4 and M5. S1 to S3 should exist before M6a's
   `expected.json` is finalized so the second source exercises them; 0.1.0 itself is not a technical prerequisite.
   **Added 2026-10-20:** the shipment lifecycle (S11 schema change, S12 shipping tab) is part of this release, sequenced before M6a so the MES-like source and its `expected.json` include deliveries and the messy variant covers delivery-before-dispatch and duplicate-delivery cases. S11 ships as its own PR (pinned contracts).
5. **Non-goals.** M3b-full (published log, pending changes, `reproject`, incremental ledger); M6b ERP-like snapshot-only source; typed rejection codes and advanced
   reconciliation guidance; declarative mapping; live append or streaming; data-health UI; Databricks; claims about real MES/ERP systems.
6. **Acceptance criteria.** Revision 3 as amended: M3a criteria; §7.4a guarantees and accounting identities; simulation parity (identical ids, sequences, hash, zero quarantine);
   M4 KPI parity at three seek points and the load budget; M5 import-boundary and module-graph tests (the app entry's transitive imports exclude the generator, `rng.ts`,
   `masterData.ts` and `src/sources/simulation/**`); M6a KPIs and detail views equal the hand-authored `expected.json`. **Strict rule retained: if any edit to `analytics/`, `ui/` or
   `graphics/` is needed to accommodate source-specific behavior, the milestone fails.** Evidence is the diff of those directories over the M6a PR(s).
7. **Demonstration scenario.** Start the app from the simulation (default) and from the MES-like fixture via the documented source option; show identical views, KPIs equal
   to `expected.json`, the source name and counts; load the messy variant and show quarantined records with their codes and reasons; show that no file under `analytics/`, `ui/` or
   `graphics/` changed. The hosted demo stays on the simulation unless the owner decides otherwise (L5).
8. **Definition of done.** §J, release 0.2.0.

### G.3 Release 0.3.0: Lakehouse Reference Integration

1. **Purpose and audience.** Show FactoryFlow consuming manufacturing datasets prepared in Databricks, and where processing responsibility lies. Audience: data-platform and
   analytics engineers.
2. **Required capabilities.** A small, reproducible Databricks example with public-safe synthetic source data; example bronze, silver and curated transformations; documented
   Delta/Unity Catalog data contracts; a repeatable export-to-FactoryFlow workflow; validation, provenance and reconciliation examples; KPI parity checks against equivalent local input;
   documentation of which processing belongs in Databricks and which stays in FactoryFlow (§H.2).
3. **Required technical milestones.** All of 0.2.0 (M4, M6a in particular); the §H deliverables. Declarative mapping only if the export cannot reuse the wire-contract adapter.
4. **Dependencies.** 0.2.0 complete; a Databricks workspace (free tier to be verified); the contract document and version.
5. **Non-goals.** A Databricks App; live streaming or CDC; production-scale processing; commercial deployment infrastructure; other platforms; a PySpark port of the reducer;
   claims about performance at scale; production readiness (G.0.1, L3).
6. **Acceptance criteria.** §H.6 (reconciliation identities T1 to T7 and the end-to-end partition, parity, defect handling, unchanged core).
7. **Demonstration scenario.** Run the documented notebook(s) (or inspect committed outputs), export the curated views, ingest them with the documented command, show the
   reconciliation report, show KPI parity with the equivalent local run, then show the defect run: injected duplicates cleaned and audited in Databricks, a conflicting pair and an
   ambiguous pair quarantined in FactoryFlow with reasons. The default hosted demo and local development work without Databricks throughout.
8. **Definition of done.** §J, release 0.3.0.

### G.4 Verification practice (no new tooling)

- CI as today (typecheck, typecheck:app, test, validate:data, build) green on every release commit.
- A manual smoke checklist (extend `deploy/ROLLBACK_AND_SMOKE.md` with generic steps): load, play, seek, open each Explorer tab, follow the late-order path to the 3D
  object, toggle each overlay, resize to a narrow width. Record the date and browser in the release notes. Automated browser tests remain an explicit gap, stated in `STATUS.md`.
- Performance numbers in release notes cite `PERFORMANCE.md` rows with date and machine.

---

## H. Databricks reference integration (release 0.3.0)

### H.1 Purpose and position

Demonstrate that FactoryFlow can consume manufacturing data that lives in a lakehouse, using a realistic pipeline: raw landing, cleaning, a curated
contract, export, ingest. It establishes maturity level **L2** (G.0.1) and nothing more: a working Databricks example does not make FactoryFlow production
ready. **Optional, after 0.2.0, never a runtime dependency.** Local simulation and replay stay first-class; the hosted demo never touches Databricks.

### H.2 What goes where

| Concern | Where | Why |
| --- | --- | --- |
| Landing raw extracts, schema enforcement, type/unit/timestamp normalization, **audited** collapse of identical duplicates, documented filters, data-quality expectations, joins to reference data | **Databricks** (SQL or PySpark; bronze, silver, curated Unity Catalog views) | Set-based; this is what Spark is for |
| Strict ordering, cross-record validity, reducer invariants, conflict handling, quarantine, accounting, analytics, UI | **FactoryFlow** (TypeScript, existing engine; Revision 3) | Sequential and stateful; already fast (`PERFORMANCE.md`) |
| Choosing between conflicting versions, resolving ambiguous order | **Neither silently.** Databricks never collapses records whose contract content differs; they pass through with their lineage for FactoryFlow to fail closed (Rev3 §7.4), or for a persisted resolution to settle | Keeps provenance and avoids hidden decisions |

### H.3 Scope: a small number of well-defined datasets

Curated views (names illustrative): `mes_events` (operation start/complete, inspections, downtime, receipts), `erp_orders` (customer orders, work orders, POs),
`master_products_boms_routings`, `master_work_centers`. They conform to a **documented, versioned contract**. Recommendation: use the existing M2 wire schema as the
contract's basis, because it is already specified, tested and independent of the domain types. Source data is synthetic and public-safe.

*Honest limitation:* if the data comes from FactoryFlow's own emitter, the demo shows the *path* (lakehouse to export to ingest) rather than independent-source robustness;
M6a is what proves independence. To make the demonstration meaningful, the bronze layer is seeded with injected defects (identical duplicates, a conflicting pair, an
unknown status code, a malformed row, a test-data row, an ambiguous-order pair, an invariant-violating event) so cleaning visibly happens in Spark and the residue is
visibly quarantined in FactoryFlow.

### H.4 Delivery mechanism (no SDK, no new runtime dependency)

1. **H1 (file export, first):** curated views exported to NDJSON/JSON with a manifest; a Node script under `scripts/` or `integrations/databricks/` runs `loadSource(adapter)`
   over the directory, mirroring M4.
2. **H2 (optional):** a Node script calls the Databricks SQL Statement Execution REST API with `fetch` and a token from the environment, writing the same files. Never from the
   browser; tokens never in the bundle. No streaming, orchestration or scheduling is required: running the notebook manually is sufficient.

Notebooks/SQL live in `integrations/databricks/` with a README. The hosted demo remains static synthetic.

### H.5 Prerequisites

- 0.2.0 complete: M4 (app boots from a source through the boundary), M6a (a second, independent adapter), M3b-core accounting (§7.4a).
- A Databricks workspace; a free tier may suffice (verify current limits and Unity Catalog/Volume support before committing; not verified here).
- The contract document and version (H.3).
- Declarative mapping only if the export shape cannot reuse the wire-contract adapter (§F.5).

### H.6 Reconciliation and provenance model

**Terms.** A **physical record** is one stored row/line (identified by a raw locator). A **logical event identity** is `RecordRef = (sourceId, sourceEventId)`; several
physical records can share one identity (duplicates, versions). Reconciliation counts physical records at every boundary and logical identities where Revision 3 does.

**Stage accounting.** Every record at a boundary lands in exactly one bucket of the next. Nothing is dropped without a listed, auditable reason.

| Boundary | Quantity | Accounting identity |
| --- | --- | --- |
| Raw, in scope of the export (`R`) | physical records in the bronze files/partitions being exported | `R` is read from bronze; bronze is append-only and never edited |
| **T1** Silver | `K` kept, `Cd` collapsed identical duplicates, `F` filtered by a documented rule, `X` rejected as malformed | `R = K + Cd + F + X`, from a `silver_disposition` table with one row per raw record (disposition, rule id or reason, and for `Cd` the locator of the kept record) |
| **T2** Curated | `C` rows in the curated views | `C = K` (one curated row per kept row). A documented transformation with another cardinality must state it and the identity becomes `C = Σ cardinality` |
| **T3** Export | `E` rows written, per-table counts, content digest, contract and transform versions in a manifest | `E = C` per table |
| **T4** Adapter | `I` canonical inputs, `Ar` adapter rejections (with `MappingIssue` and raw locator) | `E = I + Ar` (Revision 3 §7.4a, I4) |
| **T5** Ingest, physical | `Acc` accepted representatives, `Dup` duplicates ignored, `Sup` superseded, `Q` quarantined members, `U` unprojected | `I = Acc + Dup + Sup + Q + U` (§7.4a, I1) |
| **T6** Ingest, logical | `L` business-event identities, `Qi` quarantined identities | `L = Acc + Qi` (§7.4a, I2); `Q ≥ Qi` because a conflicting identity quarantines several members |
| **T7** Projection | accepted events applied to operational state | `Acc` = length of the accepted log = replayed `lastSequence` advance (§7.4a, I3) |

**End-to-end partition.** `R = F + X + Cd + Ar + Dup + Sup + U + Q + Acc`. Every raw record is in exactly one bucket, and a report generated by joining
`silver_disposition` with FactoryFlow's dispositions through the raw locator can state the fate of any one of them. The identities are asserted by a check query (Databricks side:
T1 to T3) and by the ingest script and tests (FactoryFlow side: T4 to T7); a future test fails the build if the sums do not balance.

**Rules that keep it honest.**
- *Identical duplicates* are collapsed in Databricks only when every **contract column** is equal after the documented normalization; the collapsed record is kept in `silver_disposition`
  with its locator, its own raw content digest, and the kept record's locator, and the collapse is counted per rule. FactoryFlow still treats identical duplicates that reach it as
  `DUPLICATE_IGNORED`; either layer may collapse, each reports its own counts.
- *Conflicting duplicates* (same logical identity, differing contract content) are **never** collapsed, filtered or chosen between in Databricks. All members stay in `K` and reach FactoryFlow, which
  fails closed unless the source declares comparable versions or a persisted resolution picks one.
- *Filters* (`F`) are enumerated in the contract (for example test-data markers, out-of-scope plants) with a rule id; a filter may not remove a record that a business event depends on without
  that being the stated purpose. *Malformed rows* (`X`) go to a reject table with the reason, not to oblivion.
- *Lineage columns* on every curated row: `source_system`, raw locator, `raw_content_digest`, bronze batch id, `transform_version`, `contract_version`. The adapter packs the locator and digest
  into the existing `rawRef` provenance field (its format is part of the contract) and sets `sourceId`, `adapterVersion` and `contentKey` as for any source, so FactoryFlow can explain an accept,
  reject or quarantine with a code, a message and a pointer back to the raw record. No type change is anticipated; verify against `InputProvenance` when implementing.

**Worked example (the numbers a test would assert).** 24 raw records: 1 test-data row (`F`), 1 malformed row (`X`), 2 identical duplicate pairs (`Cd = 2`), 1 conflicting pair, 1 snapshot-status row,
1 row with an unknown status code, 1 ambiguous-order pair, 1 invariant-violating event with 1 dependent event.

| Bucket | Count | Notes |
| --- | --- | --- |
| `F`, `X`, `Cd` | 1, 1, 2 | `K = 24 - 1 - 1 - 2 = 20`; `C = 20`; `E = 20` |
| `Ar` | 1 | unknown status code (`UNKNOWN_STATUS`); `I = 19` |
| `U` | 1 | snapshot row, retained, not projected |
| `Q` | 6 | conflicting pair 2 members; ambiguous pair 2; invariant-violating event 1 + its dependent 1 |
| `Acc` | 12 | `19 - 1 - 6 = 12` |
| Logical | `Qi = 5`, `L = 17` | conflict 1 identity, ambiguous 2, invariant 2; `17 = 12 + 5`, also `19 - 1 (U) - 1 (extra conflict member)` |
| End to end | 24 | `1 + 1 + 2 + 1 + 1 + 6 + 12 = 24` |

### H.7 Acceptance criteria

1. From a clean Databricks workspace, documented steps produce the curated views; check queries assert T1 to T3 and the manifest counts.
2. The export-to-ingest script runs with no Databricks credentials after export; the exported sample is committed or reproducible by seed, small.
3. **Parity (clean run):** KPIs and key views from the exported data equal the same seed run locally.
4. **Defect run:** every injected defect lands in the documented outcome row of Revision 3 §9 (read per §7.4a for rows 7, 22, 24); T4 to T7 and the end-to-end partition balance; KPI
   differences from the clean run are explained by the listed quarantined events and are **not** asserted equal.
5. The reconciliation report can answer, for any raw record, which bucket it fell in and why.
6. FactoryFlow `npm test`, CI and the hosted demo are unaffected; nothing under `src/manufacturing` or `src/analytics` changed.

### H.8 Non-goals

Live streaming or CDC; Delta Live Tables or Structured Streaming as a requirement; orchestration or scheduling infrastructure; a Databricks App; MLflow or forecasting; Unity Catalog
governance showcase; PySpark port of the reducer; other platforms; production-scale volumes; any performance claim at scale (none measured); any production-readiness claim (G.0.1).

---

## I. Deferred and out-of-scope work

| Item | Disposition |
| --- | --- |
| Subscription billing, licensing infrastructure | Out of scope |
| Multi-tenant architecture, tenant-scoped storage | Out of scope. (`tenant`/`site` already exist in identity derivation as optional strings; leave, do not extend.) |
| Managed-hosting administration, customer onboarding portal, support tooling | Out of scope |
| Generic connector marketplace; ERP/MES vendor compatibility for its own sake | Out of scope |
| Graphical mapping portal, generalized ETL framework | Deferred indefinitely; F.5 file mapping is the ceiling |
| Authentication, backend, database, message broker | Deferred; "No database, broker, auth or framework without a concrete need" stays in `CLAUDE.md` |
| Live append, streaming, real-time freshness | Deferred; depends on M3b-full and a source that needs it |
| M3b-full: published log, pending changes, explicit `reproject`, incremental reconciliation | Unscheduled; design retained in Revision 3 §7.4; M3b-core is constrained so it can be added (§7.4a) |
| Relaxed reducer / plan-conformance recording profile | Deferred pending pilot evidence (Rev3 D6, §7.9); there is no pilot |
| `ObservedState`, interpretation policy, capability-aware UX for observation-only sources | Deferred with M6b |
| Data-health UI | Deferred; counts only |
| Other data platforms (Snowflake, BigQuery, Fabric) | Not now; the contract keeps the door open |
| Workforce, skills, finite scheduling, scenarios (P11, P12) | Optional research after 0.2.0, own design note |
| Warehouse/star schema (design §10) | Deferred; reporting is computed from state |
| Checkpointing for large logs | Deferred until a dataset needs it |
| Commercial pilots, customer security review, SLAs | Out of scope; annotated in the design doc |
| Production enterprise deployment (security, HA, monitoring, governance, volume validation, domain validation) | Not provided by any release (G.0.1, L3) |
| Predictive dispatch/delivery risk, "at risk" flags, confidence bands | Deferred until a capacity model exists (P10); 0.1.0 reports observed facts only. From 0.1.x only the narrow, labelled work-order ETA (S10) exists |
| Shipment map or animated vehicle tracking | Optional last step of S12; no real carrier or GPS data exists, so any movement would be illustrative and must say so |
| Carrier APIs, live tracking numbers | Out of scope (no integration, no backend) |
| Order-level lead-time decomposition into work-order phases, transit/receipt time, quality-hold time | Deferred (need unit/lot traceability, a receipt event, incoming-quality modeling); see `KPI_DEFINITIONS.md` |

---

## J. Definition of done by release

A release is **ready for publication** only when every box for that release is checked on the release commit (G.0). Milestone and capability completion are tracked separately in
`STATUS.md` and Revision 3. Acceptance criteria for behavior are in §G; this list adds the repository, documentation and legal items. "Evidence" is how a reviewer checks.

### J.1 Release 0.1.0: Public Preview

**Status (2026-10-21): complete, evidence in [`RELEASE_0.1.0.md`](RELEASE_0.1.0.md); tagged `v0.1.0` locally. Remaining manual steps: push the tag, deploy the build.**

**Build and correctness**
- [x] `npm run typecheck`, `typecheck:app`, `npm test`, `validate:data` and `npm run build` pass in CI on the release commit.
- [x] Fixture hash `6ed76381` and log hash `1b408e8e` unchanged, or changed deliberately with a `SCHEMA_VERSION` bump, regenerated fixture and migration note (`CLAUDE.md`).

**Product**
- [x] S1a, S1b, S2, S3 shipped; definitions moved from "proposed" to implemented in `KPI_DEFINITIONS.md` (the "Proposed / Not Implemented" label removed only for what exists); unit tests recompute every
  displayed number; the exclusive decomposition reconciles to elapsed time in tests.
- [x] Reported figures are observed facts on a dispatch basis; no predicted-risk indicator exists anywhere in the UI or docs.
- [x] Order to work order to work center to 3D object path works in both directions (manual smoke, recorded); the order-to-work-order link is labelled as a planning link.
- [x] The dashboard and Explorer are fully usable without relying on the 3D scene.
- [x] Synthetic-data label visible on every view.

**Repository, documentation, legal**
- [x] `LICENSE` (Apache-2.0) present after the owner confirms ownership; dependency license scan from `package-lock.json` recorded; asset provenance list covers `public/og-v2.png`,
  `design/og.html`, favicon and icons, fonts, and the fictional name "Northstar Components" (trademark check). Done 2026-10-21, recorded in `RELEASE_0.1.0.md`; the Northstar name check found no exact match but similar real names (L6 stays open).
- [x] Git history and tracked files scanned for secrets and personal infrastructure details; `deploy/` sanitized or relocated with placeholders; `SKILL.md` and `docs/DashboardInspo.webp` still untracked.
- [x] README rewritten: purpose, synthetic-data notice, hosted-demo link, 3 to 4 screenshots, 60-second quick start verified on a clean clone with Node 22, a "what works / what is planned" section linking
  `STATUS.md`, the maturity statement (G.0.1: reference implementation, not production-certified), and an explicit statement that external-source integration is **planned, not part of this release**.
- [x] `STATUS.md` dated and matching the code at the release commit; `public/roadmap/index.html` reconciled with it; stale items from C.3 fixed.
- [x] `ARCHITECTURE.md` updated; Rev1 and Rev2 archived with a banner; `docs/README.md` index exists; `CONTRIBUTING.md` present and its commands succeed.
- [x] Hosted demo reachable without login; a fork-hosting path documented (static `dist/`).
- [x] Known limitations section lists the gaps in §C.4 that remain (including: no source-independent ingestion yet, no unit-level traceability, no workforce or scheduling).
- [x] Short (under 2 minutes) walkthrough script in the README or docs; `PERFORMANCE.md` re-measured and dated for the release build.

### J.1a Release 0.1.x: Investigation

- [ ] Everything in J.1 still true (hashes `6ed76381` / `1b408e8e` unchanged; synthetic label on every view).
- [ ] For each slice shipped: its definitions moved from "proposed" to implemented in `KPI_DEFINITIONS.md`; a `STATUS.md` row with a pointer; unit tests recompute every displayed number.
- [ ] S7: inbox rows equal the owning tabs' sets (tested per type); thresholds visible in the UI.
- [ ] S9: lead-time basis, minimum-sample rule and open/short-shipped handling documented and tested.
- [ ] S10: "forecast" label, basis and inputs on every surface; backtest published with its known bias; no "at risk" wording anywhere.
- [ ] README "what works" section updated; the roadmap page reconciled.

### J.2 Release 0.2.0: Source Independence

- [ ] Everything in J.1 still true, with docs updated for the new capabilities and the README promoting integration from "planned" to "implemented" only for what `STATUS.md` marks so.
- [ ] M3a complete: zero `it.fails` in the atomicity corpus; differential, freeze, type and fault tests pass; fixture and log hashes unchanged; the legacy header comment corrected.
- [ ] M3b-core complete per Revision 3 §7.4a: accounting identities I1 to I4 asserted in tests on the simulation, the injected-defect corpus and shuffled orders; permutation and reprocessing give deep-equal results;
  conflicting duplicates yield no accepted member; simulation parity; projection immutability test; legacy cross-check passes.
- [ ] M4: the app boots through `loadSource`; KPIs, Explorer and 3D identical at three fixed seek points before and after; zero quarantine and zero error issues for the simulation; capability gate unit-tested.
- [ ] M5: import-boundary and module-graph tests pass; `engine.*` access removed; `dataOrigin` drives the synthetic label.
- [ ] M6a: the app boots from the MES-like fixture with the simulation module absent from the module graph; KPIs and detail views equal `expected.json` (including S1 to S3 results); the messy variant pins its rows;
  **diff evidence that nothing under `analytics/`, `ui/` or `graphics/` changed to accommodate source-specific behavior.**
- [ ] Added one-time load work within the D7 budget (about 300 ms Node; no new browser long task above 500 ms), recorded in `PERFORMANCE.md`.
- [ ] `tests/legacy/` removed on the Amendment A2 evidence (final differential run recorded in the PR), before the tag.
- [ ] A short source-adapter how-to exists (contracts by reference to Revision 3, not copied); `STATUS.md` rows for sources updated; maturity statement L1 used, not more.

### J.3 Release 0.3.0: Lakehouse Reference Integration

- [ ] Everything in J.2 still true.
- [ ] §H.7 criteria met: T1 to T7 and the end-to-end partition balance on the clean and defect runs; parity on the clean run; the reconciliation report explains any raw record's fate.
- [ ] `integrations/databricks/` README with prerequisites (including the verified free-tier limits), contract version, run instructions and the Databricks-versus-FactoryFlow responsibility table.
- [ ] Synthetic source data and notebooks contain no private data or credentials; no SDK or new runtime dependency added to the app.
- [ ] The default hosted demo and local development verified to work without Databricks, in CI.
- [ ] README and release notes use maturity level L2 wording and state plainly that this is not a production deployment.

---

## K. Recommended next steps

Ordered by dependency and value. Each is a separate PR; the two lanes are independent (§F.1).

1. **Truth-alignment PR (docs only, small).** Fix C.3 items 1, 2, 3, 5, 6 and add the archive banner on Rev1/Rev2. Release lane.
2. **S1a: Order-to-Final-Dispatch Lead Time, Dispatch Lateness, Past-Due Unshipped Orders, On-Time In-Full Dispatch** (Intelligence lane). First step on the 0.1.0 critical path; its definitions are now complete in `KPI_DEFINITIONS.md`, needs no schema change.
3. **M3a: atomic reducer** (Integration lane, in parallel; not on the 0.1.0 critical path). Fully specified, guarded by the M0 harness; it also corrects the legacy header comment.
4. **S1b, S2, S3, S5/S6** in that order, then legal/asset review, README and screenshots, then tag 0.1.0.
5. **Tag 0.1.0** once the legal, README and screenshot work is done.
6. **Investigation sequence (0.1.x, Intelligence lane):** **S7** exceptions inbox → **S9** part delivery lead time → **S10** work-order ETA → **S8** trail and time comparison. (S9 before S10 because S10 consumes its lead-time basis; S7 first because it is the visible entry point and needs nothing new. S8 last because it reuses the inbox and the drawers.) Definitions in `KPI_DEFINITIONS.md` first, each as its own PR.
7. **S11 shipment lifecycle** (Domain lane, alone; design note first), then **S12** shipping tab (0.2.0).
8. **M3b-core** (Revision 3 §7.4a) once M3a has merged, then M4, M5, M6a for 0.2.0 (M6a after S11).

**The next implementation milestone I recommend (revised 2026-10-21): 0.1.0 is tagged; next is S7** (exceptions inbox), since S1 to S6 are implemented. **S9** is the first slice that carries the owner's lead-time idea and can run right behind it. **M3a** remains the next integration milestone and can be developed on its own branch at the same time.

---

## L. Decisions for the owner

| # | Decision | Status / recommendation |
| --- | --- | --- |
| L1 | License: Apache-2.0 | **Closed 2026-10-21.** Owner confirmed ownership of code and assets; `LICENSE` added; dependency and asset review recorded in `RELEASE_0.1.0.md` |
| L2 | Split M3b into core and full (R1) | **Closed: accepted 2026-10-17** |
| L3 | M6b and most of M7 unscheduled (R3/R4) | **Closed: accepted 2026-10-17** |
| L4 | Hosted-demo target | **Closed 2026-10-17.** Use the existing static hosting as the initial publishing target. GitHub Pages for forks is optional and does not block 0.1.0 (it would need Vite `base` work) |
| L5 | Independent MES source in the public demo | **Closed 2026-10-17.** The default public demo stays simulation-based. For 0.2.0, document how to run the MES-like fixture locally; no public UI source selector is required |
| L6 | Fictional company name "Northstar Components" | **Open.** Kept provisionally. A web search (2026-10-21) found no exact match but real manufacturers named Northstar, one close in business (`RELEASE_0.1.0.md` §6); not a trademark clearance. Renaming would regenerate the dataset and both hashes |
| L7 | Edit design doc and Rev3 per R1-R8 | **Closed: done 2026-10-17** |
| L8 | Analytical definitions (`KPI_DEFINITIONS.md`) | **Closed 2026-10-17.** **S1a approved** with explicit dispatch terminology (`dueDate` is dispatch-by for the synthetic manufacturer only; On-Time In-Full Dispatch, Order-to-Final-Dispatch Lead Time, Past-Due Unshipped Orders). **S1b approved** after the corrections were incorporated and checked against the reducer's operation, inspection, rework and receipt transitions and the generator's event timing: eligibility-based `QUEUE_WAIT`/`POST_PRODUCTION`, and a partial reconciliation with the drawer's step `Wait`. No unresolved contradiction was found; limitations are documented there (rounding, a possible rework-request gap, `POST_PRODUCTION` expected to be zero-length on simulated data). All metrics remain **Proposed / Not implemented** |
| L9 | Legacy reducer | **Closed 2026-10-17.** Retained through M4 as a differential-testing oracle, not a second supported reducer; removed before the 0.2.0 tag only after the evidence in Revision 3 Amendment A2 is recorded |
| L10 | Identity failures | **Closed 2026-10-17.** Identity failures with enough source identity and provenance to form a `RecordRef` and a raw locator enter the ingestion boundary as explicit quarantine outcomes (counted in I1 as quarantined physical inputs). A record that cannot be represented as a canonical input (malformed, or missing source identity) is an adapter-boundary rejection with its raw locator (counted in I4). Every physical source record has an attributable disposition. Clarified in Revision 3 §7.4a; I1 to I4 unchanged |
| L11 | Equipment and backlog conditions in 0.1.0 | **Closed 2026-10-17.** Current-state observations only, labelled "current state at <asOf>"; no historical durations, no reconstructed history. A tested event-walk implementation may come later if justified |
| L12 | Investigation-first direction (P13 to P16) | **Closed 2026-10-20 (owner).** Sequence: investigation (S7, S8), then part lead time and ETA (S9, S10), then shipping (S11, S12) |
| L13 | Meaning of "lead time" for the ETA | **Closed 2026-10-20 (owner).** Part-delivery lead time, per part, used in the material-delay term of a work-order ETA (`ETA = material-ready time + remaining work`). Order-to-dispatch lead time (S1a) is a different, already implemented metric and keeps its name |
| L14 | Lead-time basis and the first forecast | **Open, recommended: `STANDARD` by default, observed P50/P90 where the sample rule is met, basis always shown.** The first forecast (S10) is an earliest-feasible work-order date, labelled *forecast*, with a published backtest; it replaces the 0.1.0 "no forecasts" rule only from 0.1.x |
| L15 | Release placement of the new work | **Open, recommended: 0.1.x for S7 to S10 (no schema change); shipping (S11/S12) in 0.2.0 before M6a.** Alternative: a separate 0.2.0 "Investigation" and renumber Source Independence to 0.3.0 and Lakehouse to 0.4.0, which touches the Rev3 plan, §H and §J references |
