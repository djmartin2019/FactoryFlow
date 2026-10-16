# FactoryFlow — Product Vision & Technical Design

> **Status:** Living design document  
> **Audience:** Developers, architects, and AI coding agents (including Claude Code)  
> **Reference implementation:** Northstar Components, a fictional industrial electrical control-panel manufacturer  
> **Last updated:** 2026-10-15  
> **Suggested repository location:** `docs/FACTORYFLOW_DESIGN.md`

---

## 0. How to use this document (instructions for coding agents)

**Treat this document as the direction of travel, not as proof that any given feature already exists.** Before changing code:

1. Inspect the actual repository structure, current types, tests, UI, and simulation behavior. Identify what is implemented versus proposed here.
2. Preserve working functionality and existing architectural separation, especially **simulation, analytics, and rendering**. Prefer incremental refactoring and compatibility adapters over wholesale rewrites.
3. For each change, identify the domain concepts and invariants it affects; update associated tests, types, documentation, and fixtures.
4. Prefer **small, reviewable vertical slices** that work end-to-end over creating dozens of unused interfaces, tables, or UI placeholders.
5. Do not introduce a database, message broker, authentication provider, cloud platform, or framework without a concrete need and an explicit implementation decision. This is currently a browser-based simulated product; future real-world integrations should be **enabled by contracts**, not prematurely deployed.
6. Keep demo mode explicitly labeled as **synthetic**. Never present invented production history, labor availability, supplier performance, or predictions as real manufacturer data.
7. Separate **observed facts**, **derived metrics**, **simulated outcomes**, and **forecasts/scenarios**. Expose their provenance and freshness in interfaces and UI.
8. When requirements conflict, prioritize correctness of manufacturing relationships, traceability, testability, and comprehensibility over visual polish.
9. If an implementation decision is genuinely ambiguous, explain the options and consequences; do not silently cement a major architectural decision.
10. After significant changes, document: what changed, which contracts changed, migration/backward-compatibility considerations, tests run, and what remains hypothetical.

**North star:** FactoryFlow should help manufacturing leaders understand **what is happening, why it is happening, what will happen next, and which decisions could improve outcomes**.

---

## 1. Product vision

FactoryFlow is a **manufacturing operations intelligence and decision-support platform** with a 3D spatial view of plant activity. Its initial data is produced by a deterministic, accelerated discrete-event simulation of Northstar Components. Its long-term architecture must allow manufacturers to connect actual ERP, MES, inventory, quality, workforce, maintenance, and equipment data without rebuilding the application.

The product is **not** primarily a 3D animation, a general-purpose ERP replacement, or a physics-accurate factory simulator. The 3D factory is one useful presentation layer over an operational domain model.

### 1.1 Product outcomes

A plant manager should be able to:

- See current and historical order, production, materials, quality, shipping, and workforce state.
- Drill from a business KPI to the orders, units, people/roles, materials, operations, and events behind it.
- Select a **work order** or a **serialized manufactured unit** and reconstruct its timeline and genealogy.
- See where work is waiting, where resources are idle/blocked/starved, and which steps constrain throughput.
- Understand demand versus finite capacity, estimate lead times, and identify at-risk customer commitments.
- Compare hypothetical interventions (additional station, skill reallocation, overtime, expedited supply, changed sequencing) under reproducible scenarios.
- Move between business/analytical screens and an optional spatial 3D context without losing selection or filters.

### 1.2 Core principles

1. **Model business meaning first.** Scene meshes, labels, and coordinates are presentation details, not database identifiers.
2. **One semantic model, multiple sources.** Simulation and live data normalize to shared domain/application-facing contracts, with source-specific semantics retained.
3. **History is essential.** Store meaningful transactions/events and materialized current-state views; do not make current status the only record.
4. **Explicit grain.** Every entity, event, metric, and fact has an unambiguous unit of observation.
5. **Explainability over false precision.** Lead-time and bottleneck recommendations show their assumptions, contributing constraints, and uncertainty.
6. **Operational reality is messy.** Support partial receipts, split jobs, revisions, variable runtimes, incomplete integrations, and late/corrected data.
7. **Modular growth.** A small coherent end-to-end flow beats a broad, hollow ERP clone.
8. **Do not equate high utilization with success.** Throughput, flow time, WIP, delivery reliability, quality, and cost must be interpreted together.

### 1.3 Explicit non-goals for the initial phases

- Replacing manufacturers' accounting, payroll, HR, ERP, SCADA, PLC controls, or safety systems.
- Writing commands directly to industrial controllers or controlling physical machines.
- Production-grade predictive AI or optimization before credible historical/operational data and baselines exist.
- Universal support for every discrete/process manufacturing model in v1.
- Building a full enterprise security stack merely for the synthetic prototype.
- Full photorealism or faithfully modeling each wire, screw, or electrical test procedure in the 3D scene.

---

## 2. Current baseline: preserve and extend

**Based on project discussions; verify in repository before treating as implemented:**

- A Three.js-based 3D factory dashboard with a modular distinction among simulation, analytics, and rendering.
- Northstar Components makes NCP-100, NCP-200, and NCP-300 control panels.
- Simulated receiving docks, raw-material racks, assembly workstations, quality/inspection cells, and shipping bays.
- Existing UI indicates good units, WIP, active production orders, utilization, first-pass yield, material shortage blocking, workstation status, and manufacturing activity.
- Adjustable simulation speed/time controls, including accelerated playback; factory objects can be inspected.
- Recent layout work described a larger 80 × 44 m building and six assembly stations, three QC cells, four raw-material racks, three receiving docks, and three shipping bays. **Confirm the exact current layout in source code; screenshot/layout versions may differ.**
- A performance overlay is available in some revisions (`?perf` or `P`); preserve performance-sensitive behavior.

**Do not tear down the current demo.** Evolve it by adapting its existing production and inventory events to better domain contracts and eventually adding more realistic routings and resource rules.

---

## 3. Reference manufacturer: Northstar Components

Northstar is a fictional **make-to-order / configure-to-order** industrial electrical control-panel builder. It may also replenish common subassemblies or standard configurations to stock. Customers include OEM machinery builders, system integrators, process plants, infrastructure operators, and industrial facilities.

| Product | Typical application | Simulated legacy assembly time | Relative complexity |
|---|---|---:|---|
| `NCP-100` Basic Control Panel | Simple equipment automation | 12 simulated minutes | Low |
| `NCP-200` Motor Control Panel | Motor control, drives, pumps, conveyors | 20 simulated minutes | Medium |
| `NCP-300` Advanced Automation Panel | PLC-based machine/line control | 35 simulated minutes | High |

**Times above are existing demo parameters, not claims about real electrical-panel labor hours.** Real build, engineering, procurement, inspection, and test durations may span hours, days, or longer. When adding detailed routings, document simulation time scaling separately from real-world estimating assumptions.

### 3.1 Example product-specific routing

The simulator should gradually replace a single generic “assembly” timer with operations that draw on different resources. Suggested *conceptual* routing:

| Operation | NCP-100 | NCP-200 | NCP-300 | Principal constraints |
|---|:---:|:---:|:---:|---|
| Engineering/revision release | sometimes | often | often | engineering availability; approvals |
| Material picking/kitting | yes | yes | yes | BOM availability; pick capacity |
| Enclosure/mechanical preparation | yes | yes | yes | tools, mounting plates, mechanics |
| Component mounting | yes | yes | yes | kit, assembly labor, benches |
| Wiring & termination | yes | yes | yes (heavier) | qualified electrical technicians |
| VFD/motor-control setup | optional | usually | optional | drives, qualified staff |
| PLC/HMI/network configuration | optional | optional | usually | controls engineering, licensed tools |
| Visual/electrical inspection | yes | yes | yes | qualified inspectors |
| Functional testing / FAT | basic | expanded | complex | test fixtures and test skills |
| Rework & retest | on failure | on failure | on failure | defect type and available resources |
| Pack, ship, install/commission | per contract | per contract | per contract | logistics, field technicians |

Different SKUs/revisions may **skip operations**, require alternative resources, or have different test durations. In a real shop, tasks may overlap or occur in cells rather than flow in one rigid linear conveyor. Model **routing precedence/dependencies**, not only a hardcoded list.

### 3.2 Physical versus logical plant

Maintain separate concepts for:

- **Site/area/location:** where a thing is physically stored or performed.
- **Work center:** a logical capacity-planning group (for example, wiring).
- **Workstation/resource:** an eligible individual physical station or test bench.
- **Equipment:** a tool/machine that may be required by an operation and may fail or need maintenance.
- **3D scene object/layout mapping:** coordinates and mesh IDs representing locations/resources in the renderer.

One operation may require **multiple simultaneous resources** (e.g., wiring bench + qualified technician + calibration device). A station may exist physically but be unusable because one of those resources is missing.

---

## 4. End-to-end manufacturing lifecycle

**Important vocabulary:** A *customer purchase order* is received by Northstar and normally represented internally as a **sales order**. Northstar's **supplier purchase orders** purchase parts/materials. These must not share a single ambiguous `purchase_order` entity.

### 4.1 Planned business flow

```text
Customer PO / demand
    -> Sales Order + Sales Order Lines
    -> Product configuration and engineering release
    -> Applicable Product Revision + effective BOM + Routing
    -> Material requirements and finite-capacity planning
       |-> Reservations / procurement proposals -> Supplier POs
       |   -> Receipts -> Incoming QA -> Inventory -> Kitting
       `-> Work Order(s) -> Operation schedule / labor assignment
    -> Work Order release (subject to release policies)
    -> Execution operations (assembly, wiring, configuration, testing)
    -> QA disposition (pass / hold / rework / scrap) and retesting
    -> Serialized finished unit(s) / finished-goods inventory
    -> Shipment / delivery
    -> Installation / commissioning, if contracted
    -> Warranty / service events, if available
```

This is not always one serial chain: procurement, engineering, and production planning can overlap. One customer order line may be fulfilled by multiple WOs or finished-goods allocations; one WO may replenish inventory for multiple future customers. Use explicit allocation links when needed.

### 4.2 Identifiers and critical relationship rules

- **Product / item:** catalog item or manufactured product definition, not a particular physical object.
- **Product revision:** immutable/effectively versioned definition used for a build.
- **BOM / BOM line:** component quantity and unit of measure applicable to a product revision and effectivity period.
- **Routing / routing operation:** process definition and precedence/eligible resource requirements.
- **Sales order line:** demand for a product/configuration/quantity/date.
- **Work order:** manufacturing authorization for a quantity, product configuration/revision, and site.
- **Operation execution / attempt:** a specific occurrence of a routing step on a WO or unit; repeated attempts are expected after rework.
- **Manufactured unit:** an actual serialized panel (`unit_id`, optional `serial_number`); distinct from product master and WO.
- **Inventory lot / serial:** traceable material instance, where source information supports it.
- **Shipment line:** actual quantity/serialized units shipped, linked to order fulfillment allocations.
- **Installation/service record:** downstream event for a unit or installed asset, not automatically performed for every unit.

**Relationships are not all one-to-one:** use `sales_order_work_order_allocation`, `work_order_unit`, `shipment_unit` / shipment-line allocations, and component consumption links as appropriate. Choose and document cardinalities based on actual use cases rather than assuming a rigid universal mapping.

---

## 5. Canonical domain model

Use these as **conceptual contracts**, not an instruction to create every table immediately. Implement entities when a vertical slice needs them.

| Domain | Main entities | Notes |
|---|---|---|
| Organization | `Tenant`, `Site`, `Area`, `Location` | Tenant/site scoping from start; location hierarchy need not mirror rendered geometry |
| Engineering | `Item`, `Product`, `ProductRevision`, `BOM`, `BOMLine`, `Routing`, `RoutingOperation` | Revision/effectivity; configurable BOMs; UOM |
| Customer demand | `Customer`, `SalesOrder`, `SalesOrderLine`, `DemandAllocation` | Request/promise dates; split/partial fulfillment |
| Procurement | `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`, `Receipt`, `ReceiptLine` | Ordered vs received vs accepted quantities; lead time |
| Materials | `InventoryItem`, `InventoryLot`, `InventoryBalance`, `InventoryTransaction`, `MaterialReservation`, `MaterialIssue`, `MaterialReturn` | Source-of-truth events/transactions; available-to-promise ≠ on-hand |
| Production | `WorkOrder`, `WorkOrderOperation`, `OperationExecution`, `ManufacturedUnit`, `ComponentConsumption` | Work-order qty, unit status, attempt history |
| Resource capacity | `WorkCenter`, `Workstation`, `Equipment`, `ResourceCalendar`, `Shift`, `Skill`, `EmployeeQualification`, `Assignment` | Calendars, skills, eligibility, downtime |
| Quality | `Inspection`, `TestResult`, `Nonconformance`, `Defect`, `ReworkOrder`, `Disposition` | Differentiate first attempt versus retest |
| Fulfillment | `FinishedGoodsStock`, `Shipment`, `ShipmentLine`, `ShipmentAllocation`, `Installation`, `ServiceEvent` | Shipping does not imply delivery or acceptance |
| Audit/integration | `ManufacturingEvent`, `SourceIdentityMap`, `SourceRecord`, `IngestionRun`, `DataQualityIssue` | Provenance, correction, synchronization |
| Simulation/planning | `SimulationScenario`, `ScenarioAssumption`, `Schedule`, `CapacityPlan`, `ForecastRun` | Never mix hypothetical results with observed actuals |
| Visualization | `SceneLayout`, `SceneObjectBinding` | Maps stable business/resource IDs to 3D meshes and coordinates |

### 5.1 Modeling rules and invariants

- Canonical IDs are stable, opaque, and uniquely scoped; do not use array indexes, labels, scene mesh names, or user-facing order numbers as primary identity.
- Preserve **external business keys**, source system, source entity name, source primary key, and mapping version separately.
- Record quantities as `{ value, uom }` (or equivalently well-typed numeric + UOM); explicitly convert and validate units. Do not silently combine `each`, meters, feet, etc.
- Capture **site** and relevant location on facts and events; inventory may require lot, status (available/quarantine), ownership, and reservation dimensions.
- Distinguish **on-hand**, **allocated/reserved**, **available**, **on-order**, **in-transit**, and **quarantined** quantities; never equate them.
- An inventory **reservation** does not physically consume stock; an **issue/consumption** does. Allow returns, reversals, and adjustments with reasons.
- Preserve engineering revisions and BOM/routing effectivity used for each work order. Never rewrite old WO history when master data changes.
- Partial quantities, split/merge/reopen/cancel WOs, partial receipts, and rework must not make history inconsistent.
- Distinguish operation **definition** (`routing_operation_id`) from **scheduled instance** (`work_order_operation_id`) from **actual execution attempt** (`operation_execution_id`).
- A work order can make multiple units; a serialized unit can undergo repeated operations and tests.
- A quality failure must not increment first-pass-good units; rework/retest success may count toward final-good units under an explicit definition.
- Define an explicit status transition model for each aggregate and reject or flag impossible transitions instead of coercing them silently.
- Represent unknown/not integrated separately from known zero. No synthetic defaults when showing real customer data.

### 5.2 Example work order state machine

```text
DRAFT -> PLANNED -> RELEASED -> IN_PROGRESS -> COMPLETED -> CLOSED
  |        |         |              |
  `--------+---------+--------------+--> CANCELLED (subject to policy)
                      |              |
                      +--> ON_HOLD --+--> IN_PROGRESS
```

Avoid a single status field carrying every concern. Hold reason, material readiness, QC state, scheduling status, and shipping status are separate dimensions. Transitions should respect partial completion and cancellation rules.

### 5.3 Example operation execution state machine

```text
PENDING -> READY -> QUEUED -> RUNNING -> COMPLETED
                        |        |         |
                        |        +--> PAUSED / BLOCKED -> RUNNING
                        |        +--> FAILED -> REWORK_REQUIRED
                        `--> CANCELLED (per policy)
```

`QUEUED` is not the same as `READY`: a job may be eligible but not yet waiting in a physical dispatch queue. Define semantics consistently in implementation.

---

## 6. Source-independent data architecture

### 6.1 Target logical architecture

```text
   Synthetic simulation              Real enterprise/plant sources
   (deterministic events)           (ERP, MES, WMS, QMS, HR, CMMS,
                                         IoT / historians)
            |                                  |
            v                                  v
    Simulation adapter                  Source-specific connectors
            |                         (API, batch, CDC, native events)
            |                                  |
            +-----------> Normalization / anti-corruption layer
                                   |
                         Identity / units / validation
                                   |
                      Canonical commands, facts, events
                                   |
                      History + current-state projections
                                   |
                      Domain query / analytics contracts
                          /           |             \
                   Dashboard      Planning         3D scene
```

In the demo, the layers may run entirely in memory. In a real deployment, ingestion and canonical storage may run on a backend, with near-real-time read models served through authenticated APIs. **The contracts should outlive the storage and transport choices.**

### 6.2 Source adapter contract

An adapter must:

1. Identify the producer, tenant/site, dataset/entity type, source IDs, and extract/capture time.
2. Map source-specific identities to stable canonical entities, recording unresolved/ambiguous mappings.
3. Normalize known units, time zones, enums, lifecycle semantics, and relationships.
4. Validate contracts and route malformed/ambiguous records to a review/quarantine path.
5. Emit source-provenanced domain observations/events **without fabricating facts**.
6. Handle duplicates, replay, corrections, out-of-order arrival, partial availability, and reprocessing.
7. Report connectivity, data freshness, completeness, and unsupported capabilities.

**Do not assume every ERP/MES has event-level history.** Sources may provide (a) genuine business events, (b) table CDC records, or (c) periodic snapshots. A change detected between snapshots is an **observed state change**, not evidence of the exact moment or cause of a business action. Preserve this distinction.

### 6.3 Simulation versus real-data capability boundary

- **Observation mode:** display known real system state and trustworthy derived historical KPIs; no speculative events represented as facts.
- **Simulation/demo mode:** authoritative synthetic world controlled by a simulation clock; generated events and entities can be complete by construction.
- **Scenario mode:** branch from a well-defined observed or synthetic baseline, then forecast under hypothetical assumptions. Never write scenario results into actual operational history.

Not every real manufacturer will expose everything needed for employee utilization, station-level WIP, genealogy, or trustworthy lead-time predictions. Show a **capability status** and data quality caveats per feature.

### 6.4 Suggested interface boundaries (illustrative TypeScript)

```ts
interface ManufacturingReadModel {
  getPlantOverview(query: OverviewQuery): Promise<OverviewResult>;
  getWorkOrder(id: CanonicalId): Promise<WorkOrderDetail | null>;
  getUnitHistory(id: CanonicalId): Promise<UnitHistoryResult>;
  getWorkCenterState(query: ResourceQuery): Promise<ResourceState[]>;
  getMaterialAvailability(query: MaterialQuery): Promise<MaterialAvailability[]>;
  getKpis(query: KpiQuery): Promise<KpiResult>;
}

interface ManufacturingEventFeed {
  subscribe(handler: (event: ManufacturingEvent) => void): () => void;
}

interface ScenarioService {
  createScenario(request: ScenarioRequest): Promise<ScenarioId>;
  evaluateScenario(id: ScenarioId): Promise<ScenarioEvaluation>;
}
```

Types above are **design illustrations**, not instructions to copy verbatim into the current repository. Inspect and evolve existing types first. Keep **reads separate from commands** such as releasing work orders or changing schedules. Real operational commands require authority, validation, audit trails, and integration-specific writeback; demo controls must never trigger physical equipment actions.

### 6.5 The 3D contract

The renderer receives a **scene state projection**, not internal simulator objects. For example, a binding associates `workstation_id = ST-WIRING-02` with `scene_object_id = scene/assembly-02`. Selecting either the dashboard work order or the scene object navigates through canonical IDs to the same detail view.

Rendering should tolerate partial or stale state: show unknown/unavailable instead of guessing. Define update throttling and performance budgets independently from event speed (especially at 3,600×/86,400× simulation speed).

---

## 7. Event model and temporal semantics

Prefer an append-friendly operational history **where supported** plus reconciled current-state projections. An event stream is not a guarantee that all external systems expose true business events; do not require full event sourcing for every future deployment.

### 7.1 Minimum event envelope

```json
{
  "event_id": "evt-000184",
  "event_type": "operation.completed",
  "schema_version": 1,
  "tenant_id": "northstar-demo",
  "site_id": "site-01",
  "source_system": "factoryflow-simulator",
  "source_record_id": "sim-op-184",
  "origin_kind": "simulated_event",
  "occurred_at": "2026-10-15T14:32:00Z",
  "observed_at": "2026-10-15T14:32:00Z",
  "ingested_at": "2026-10-15T14:32:01Z",
  "correlation_id": "wo-0057",
  "entity_type": "operation_execution",
  "entity_id": "exec-0184",
  "payload": {
    "work_order_id": "wo-0057",
    "manufactured_unit_id": "unit-0184",
    "work_order_operation_id": "woo-wiring-57",
    "routing_operation_id": "routing-ncp300-rev-c-wiring",
    "workstation_id": "st-wiring-02",
    "good_quantity": 1,
    "scrap_quantity": 0,
    "uom": "EA"
  }
}
```

Use `origin_kind` values like `simulated_event`, `source_business_event`, `cdc_change`, `snapshot_observation`, and `manual_correction` to preserve interpretation. For a source without a reliable occurrence timestamp, store it as **unknown/null** and use observed/capture time with clear semantics, not an invented event timestamp.

### 7.2 Processing guarantees and corrections

- Event IDs and source idempotency keys prevent duplicate effects on replay.
- Preserve source payload (or an auditable pointer/hash) when possible; normalized records should be reproducible from their inputs and mapping versions.
- Handle out-of-order and late data through deterministic projections, bounded reprocessing, or reconciliation.
- Support correction/reversal events rather than silently mutating past facts; decide retention and audit strategy when actual storage is selected.
- Define timestamp semantics: source occurrence, observation, ingestion, effective time, last reconciliation, and simulator clock are not interchangeable.
- Simulation clock **must not use wall time** for manufacturing duration or scheduled event ordering. Use deterministic event ordering (time plus stable tie-breaker).

### 7.3 Example end-to-end serialized history

```text
Customer order line SO-1042-01
  -> manufacturing allocation to WO-0057
  -> product NCP-300 Rev C, effective BOM & routing
  -> material reservation + actual lot/serial issues
  -> unit U-0184 serialized
  -> mechanical assembly completed
  -> wiring attempt #1 completed
  -> functional test attempt #1 FAILED
  -> nonconformance opened, rework performed
  -> functional test attempt #2 PASSED
  -> final disposition ACCEPTED
  -> shipment S-0098 / tracking reference
  -> customer installation record, if integrated
```

The unit history must display both the original failure and successful retest. Do not overwrite one with the other.

---

## 8. Realistic simulation design

### 8.1 Prefer discrete-event simulation

Use a simulation clock and an event priority queue for consequential changes rather than making each workstation independently decrement wall-clock timers. Example triggers: receipt arrives, kit is ready, shift starts/ends, operation starts/finishes, breakdown occurs, test fails, rework completes, shipment dispatched.

Track and control reproducible randomness with a seed. Ensure reset/replay produces equivalent event sequences from equivalent inputs. For scenario comparisons, use common random streams/seeds when appropriate to reduce noise.

### 8.2 Capacity and scheduling realism

Represent at minimum:

- Product-specific **routing durations**, setup/changeover durations, and processing-time variability.
- Eligible workstation/work center and required **skill**, worker availability, equipment, and materials.
- Finite queues, resource contention, bottleneck migration, and blocking/starvation.
- Shift calendars, breaks, planned maintenance, failure/repair, absence, and eventually overtime.
- Procurement lead times, stockouts, substitutions subject to approval, incoming quality hold, and partial receipts.
- First-pass defects, rework loops, retest, and realistic potential scrap/replacement.
- Work order due dates and dispatching priorities; planners may compare FIFO, earliest due date, critical ratio, etc., without declaring a universal best rule.

Do not assume each physical station maps to a single operation, or that all people can staff all stations.

### 8.3 Start with useful scenarios

1. **Material shortfall:** PLC shortage blocks NCP-300 orders; supplier receipt and potential expedite alter recovery date.
2. **Wiring skill constraint:** Empty assembly space does not improve output if qualified electrical technicians are unavailable.
3. **QA specialization:** Aggregate QA utilization appears low, but advanced-panel test bench becomes a product-specific bottleneck.
4. **Quality incident:** Elevated failure/rework rates increase lead time, WIP, and cost despite nominal station capacity.
5. **Demand mix shift:** More NCP-300 orders change bottleneck and labor requirements even when total order count stays constant.
6. **Capacity experiment:** Compare six assembly/three QA with eight assembly/two QA using equal demand/seed and actual output/queue/cost metrics.

### 8.4 Bottleneck analysis rules

Avoid the heuristic “highest utilization equals bottleneck.” Consider per-operation demand load vs effective capacity, queue arrival/service rates, sustained waiting times, flow blocking, labor/equipment/material constraints, product mix, and marginal throughput gain under relief scenarios. Distinguish a **local busy station** from the **system constraint**.

A simulated recommendation should say *why* the constraint was identified and what assumptions were used. Example: “Adding a seventh assembly bench is predicted to change throughput by <1% because technician-hours in wiring remain the limiting resource” (only if actually calculated).

---

## 9. Operational UI and analytics

### 9.1 Navigation and questions answered

| View | Primary questions | Core capabilities |
|---|---|---|
| Executive / Plant Overview | What is healthy, at risk, or worsening? | KPI cards, alerts, drill-through, time range |
| Orders & Unit Traceability | Where is my order/unit; what happened? | WO/unit detail, lineage, event timeline, revision history |
| Scheduling & Planning | Can we meet committed dates? | Capacity/load, planned vs actual, estimated completion, what-if |
| Inventory & Procurement | What material shortages will stop production? | BOM explosion, availability, reservations, ETA, suppliers |
| Production / Work Centers | Where is WIP, where are bottlenecks? | Queue analysis, cycle/wait time, utilization, idle reason |
| Workforce | Who can do the work and when? | Shift/skill coverage, assignments, workload, overtime risk |
| Quality | What is failing and how costly is rework? | First-pass yield, defect Pareto, repeat tests, traceability |
| Shipping & Field Lifecycle | Which commitments shipped, installed, serviced? | Serial shipment history, delivery/commissioning status |
| 3D Plant | Where are the affected resources and orders? | Spatial states, status overlays, selection, navigation to details |
| Scenario Comparison | Which action is best under assumptions? | Baseline vs alternate throughput, WIP, lead-time percentiles, cost |
| Data Health / Integrations (real deployments) | What do we know and how fresh is it? | Source freshness, mapping issues, availability, confidence |

3D is optional for many decisions; charts, tables, timelines, and exception lists often communicate more clearly. The scene is a **spatial index into operational context**, not the primary source of truth.

### 9.2 Metric dictionary: definitions before charts

Every KPI must specify **grain, time basis, numerator/denominator, filters, source, and refresh policy**. Initial candidates:

- **Good units produced:** distinct completed manufactured units accepted by final QA in selected period; define when unit becomes 'good'.
- **First-pass yield:** units passing the required quality gate on first attempt / units completing their first attempt of that gate. Distinguish step-specific from end-to-end first-pass yield; do not combine or count retests as first passes.
- **WIP:** units (or equivalent unit quantity) started but not yet completed/closed, optionally by stage; define treatment of released-but-unstarted kits and rework.
- **Workstation utilization:** productive busy time / available scheduled capacity time over a period; include selected denominator rules for setup, downtime, staffed/un-staffed, and idle. Never average percentage metrics without appropriate weighting.
- **Throughput:** good units accepted per elapsed manufacturing time, by product/work center/site as applicable.
- **Cycle/flow time:** elapsed start-to-end for a unit/order; distinguish touch/processing time from queue/waiting and procurement lead time.
- **On-time delivery:** shipped/delivered by agreed commitment date using explicitly selected milestone.
- **Blocked by material:** distinct eligible orders/operations currently unable to proceed due specifically to verified material shortfall; avoid double counts.
- **Schedule adherence:** actual completions versus approved plan at an explicit granularity.
- **Capacity/load:** required standard hours (routing × demand) versus available qualified staffed resource-hours, including calendars and planned downtime.
- **Inventory accuracy:** only with actual count/reconciliation observations; unavailable if a source cannot support it.

Support **current snapshot metrics** and **period metrics** separately. Current WIP should not change just because a user selects an earlier KPI aggregation window unless they explicitly request an *as-of* historical snapshot. Show units and time zone clearly.

### 9.3 From alerts to explanations

A useful alert links to evidence and suggested action rather than merely saying “Production delayed.” Example:

> **WO-0057 at risk (forecast).** NCP-300 requires 14 more eligible PLC modules than currently available. Next confirmed inbound receipt is expected on Friday; wiring personnel are not the immediate constraint. Based on present procurement and schedule assumptions, predicted completion is 1.5 days after the committed date. Consider expediting the parts or reprioritizing available stock.

Never generate such a statement unless the underlying facts and forecasting model actually support it. Separate **reported ETA**, **calculated projected ETA**, and **user-entered assumption**.

---

## 10. Analytics and data warehouse design

A single giant table is not the correct canonical model. Keep normalized operational entities for identities/transactions and purpose-built analytical facts/aggregates for queries.

Suggested analytical model (implement incrementally):

| Analytical object | Proposed grain |
|---|---|
| `fact_operation_execution` | One operation execution attempt (including rework) |
| `fact_inventory_transaction` | One posted movement/adjustment/reservation-related transaction (use distinct types) |
| `fact_component_consumption` | One actual component issue/return against a WO/unit with quantity, lot when known |
| `fact_quality_result` | One inspected unit/test/check/attempt according to documented test grain |
| `fact_resource_state_interval` | One contiguous resource state interval, with start/end and reason |
| `fact_order_fulfillment` | One fulfilled quantity allocation / shipment association at documented grain |
| `fact_shift_capacity` | One resource/skill/shift availability segment |
| `fact_work_order_snapshot` (optional) | One work order as-of snapshot time; **snapshot**, not event |

Conformed dimensions may include site, product/revision, resource/work center, employee/skill, customer, supplier, calendar/shift, and defect/reason.

Prevent fanout errors when joining fact tables at differing grain. Derived measures must remain consistent between the simulated data adapter and any real-data implementation. Late corrections should trigger appropriate recalculation/reconciliation, not leave permanently incorrect KPI caches.

---

## 11. Planning, forecasts, and scenarios

### 11.1 Planning inputs

- Open demand and promised dates.
- Effective BOMs, routing precedence, operation times, required skills/tools.
- Available/raw/quarantined/on-order materials and realistic supplier ETAs.
- Workstation/equipment calendars and labor qualifications/shift calendars.
- Current WIP position and incomplete/blocked work.
- Quality/rework probabilities and observed variability (when sufficient data exists).

### 11.2 Planning outputs

- Feasible capacity and projected completion dates by order/operation.
- Shortage and resource-risk explanations.
- Queue/backlog trend and WIP by department.
- On-time-delivery exposure and projected late quantities.
- Scenario comparison on throughput, flow-time distribution (including P50/P95), quality, overtime, material expedites, and costs.

Provide model version, assumptions, data freshness, baseline time, and uncertainty. An estimated date is **not** a customer promise unless an authorized person makes it one. For live operations, read-only scenario analysis should precede any planning writeback.

### 11.3 Scenario isolation

Scenario evaluations must be clearly versioned and isolated from operational truth. Suggested: `baseline_snapshot_id`, `scenario_id`, `simulation_seed`, `assumptions`, `model_version`, `computed_at`, `outputs`. Comparisons should use equivalent demand and calendar windows wherever possible.

---

## 12. Real-world integration and deployment concerns

### 12.1 Data acquisition patterns

- ERP/MES APIs for orders, products, receipts, and status.
- Batch exports for older/on-prem systems.
- CDC where legally/operationally appropriate and supported.
- Native events/webhooks when systems truly publish domain events.
- Historian/OPC UA/IoT telemetry **via approved, read-only, secure integration services** for machine state where available.
- Field/service and shipping systems for post-production lifecycle.

A PLC tag change is not automatically a work-order completion; higher-level business semantics often require correlation across sources and human transactions.

### 12.2 Identity, privacy, and trust

- Explicit tenant/site scoping and access control in real deployments.
- Employee names, shifts, absences, and performance data are sensitive; restrict exposure and minimize unnecessary personal data in dashboards and events.
- Read-only connectors by default; no direct equipment control. Operational writebacks, if ever pursued, need dedicated approval, audit, and safety review.
- UTC or other documented canonical instant format internally; display local site time with time-zone metadata and daylight saving behavior defined.
- Retain integration lineage, deduplication keys, reconciliation runs, and data-quality statuses.
- Define operational latency expectations per connector. If last reliable MES sync was 45 minutes ago, do not call the dashboard real-time.

### 12.3 Capability-aware UX

A real factory may support `orders + receipts + shipments` but not unit serial tracking or labor assignments. Each major module should distinguish `available`, `partial`, `stale`, `unmapped`, `unsupported`, and `unknown` rather than presenting zeros and fabricated confidence.

---

## 13. Engineering standards and testing strategy

### 13.1 Architecture and code quality

- Preserve separation of **domain logic, simulation engine, ingestion/adapters, analytics/read models, UI, and rendering**.
- Prefer cohesive modules and pure computation for business logic; isolate I/O, time source, randomness, and storage.
- Use explicit typed IDs, discriminated event types, runtime validation at external boundaries, and documented units.
- Avoid circular dependencies and renderer-specific types leaking into domain/analytics.
- Keep a single source of truth for key definitions, KPI calculations, and state transition rules.
- Do not introduce an elaborate plugin framework until two genuinely different adapters justify it.

### 13.2 Test pyramid / invariants

**Unit tests**

- Correct BOM explosion and material availability/shortage handling.
- Reservations versus issues versus returns; no negative stock unless explicitly allowed and flagged.
- State-transition validity, operation precedence, rework loops, split quantities.
- First-pass yield, WIP, utilization denominators, lead-time calculations.
- Mapping normalization, units, timestamps, and unknown values.

**Simulation tests**

- Repeatability with fixed seed, accelerated speed independent of results, reset/replay correctness.
- Resource exclusivity: one employee/equipment resource cannot be double-booked in overlapping operations unless explicitly capacity > 1.
- Operations cannot start without all mandatory eligible resources and material conditions.
- Conservation checks: received/issued/returned/scrapped quantities reconcile within documented adjustments.
- Disrupted scenarios create appropriate queues/holds/rework; lifting constraints changes outcomes as expected.

**Integration/contract tests**

- Run equivalent canonical fixture data through synthetic and persisted/static adapters; assert consistent read models and KPIs.
- Idempotent source replay, late/out-of-order/corrected records, unknown IDs to quarantine.
- Partial and stale data produce honest UI states.
- Work order/unit drill-down IDs resolve end to end across overview, timeline, and 3D binding.

**UI/performance tests**

- Filters and KPI periods have consistent semantics; reset returns a known demo state.
- 3D object selection links correctly to operational detail, and render throttling avoids simulation-speed-induced UI lockup.
- Benchmark typical and stress synthetic loads; don't trade correctness for visually impressive frame rates.

### 13.3 Definition of done for new features

A feature is done when:

1. Domain semantics and grain are defined.
2. The simulation or adapter supplies realistic, correctly typed inputs.
3. Domain tests and representative edge cases pass.
4. A user can investigate source entities behind the UI metric/alert.
5. Empty/unknown/stale states are handled.
6. Documentation, expected behavior, and relevant migration notes are updated.
7. Existing simulator and scene workflows still run.

---

## 14. Phased development roadmap

This is a sequence of **vertical slices**, not permission to implement everything at once.

### Phase 0 — Architecture audit and contracts

- Read existing source and map actual components/data flows: master data → simulation → analytics → UI/3D.
- Document current IDs, entity relationships, event shapes, clocks, KPI definitions, and tests.
- Identify coupling to scene objects and direct simulator state; add adapter boundaries in-place.
- Add a small canonical fixture and contract tests. Establish baseline correctness and performance.

**Exit:** A documented path exists from current demo data to UI metrics; new types/contracts are added only where needed.

### Phase 1 — Production routing realism

- Separate logical work centers from physical workstations; add routing operations and precedence.
- Give NCP-100/200/300 different workflows, processing distributions, skill and equipment requirements.
- Introduce queue/wait, setup, starved/blocked/working/downtime states.
- Keep existing 3D layout and gradually relabel/repurpose workstations rather than immediately reconstructing the entire scene.

**Exit:** Different product mixes and resource limitations create observable, explainable bottlenecks; same seed gives reproducible outcomes.

### Phase 2 — Work-order and serial-unit traceability

- Establish `SalesOrderLine -> WO allocation -> WO operation execution -> Unit` traceability.
- Snapshot effective BOM/routing revision on the WO; persist unit events and actual material issues.
- Implement work-order detail and serialized-unit history (including first failure/retest).
- Link existing 3D selection to canonical detail views.

**Exit:** Select a unit and reconstruct its full manufacturing history from events/facts without guessing.

### Phase 3 — Procurement and material constraints

- Model supplier POs, receipts, lead times, quarantine, reservations, picking/kit issues, shortages.
- BOM explode against actual available quantities, consider substitutes and inbound supply where explicitly supported.
- Show shortage root cause and downstream order/throughput impact.

**Exit:** Material delays change executable schedules and have traceable, visible effects.

### Phase 4 — Workforce and finite-capacity scheduling

- Add skill matrix, shifts, absences, staff/equipment calendars, assignments, overtime options.
- Build workload versus capacity, resource-specific queues, and estimated completion dates.
- Provide reasoned risk flags and labor-related bottleneck explanations.

**Exit:** An extra station alone may not increase throughput when skill availability is limiting.

### Phase 5 — Scenario comparison and decision support

- Implement isolated baseline snapshots and parameterized what-if branches.
- Compare capacity configurations, labor shifts, defect rates, supply lead times, and demand mix.
- Report throughput, WIP, flow times, OTD, resource hours, and assumed costs, with model version/seed.

**Exit:** A manager can defensibly compare two proposed changes without altering live/baseline state.

### Phase 6 — Real-data readiness / pilot adapter

- Build a second adapter from a **small realistic external-style fixture or persisted dataset**, not directly from simulator internals.
- Introduce source identity maps, provenance, quality/quarantine, partial capability and freshness.
- Prove equivalent dashboard queries over both sources with contract tests.
- Only when a pilot requires it, choose backend storage, authentication, integration transport, scheduling, and deployment components.

**Exit:** A representative external order/operation/inventory dataset powers the same UI contracts without renderer/analytics rewrites. A true customer pilot follows security and data-governance review.

---

## 15. Immediate next vertical slice (recommended)

**Slice: realistic NCP-300 routing plus traceable work order**

Why: this creates the fewest moving parts while proving the new architecture and enabling later QA/workforce/bottleneck analysis.

**Deliverables:**

1. Inspect the repo and summarize implemented flows before changing them.
2. Define a minimal `Routing` + `RoutingOperation` + `WorkOrderOperation` + `OperationExecution` model (or adapt existing equivalents).
3. Add distinct NCP-300 steps: kit → mount → wire → configure → test → disposition; assign eligible resources and durations, with existing legacy timings migrated or intentionally retained for compatibility.
4. Emit/version events at operation start/completion/hold and QA pass/fail/rework.
5. Add a work-order detail timeline and link the current scene selection to the relevant operation/WO.
6. Validate with one seeded scenario where the NCP-300 test fails once, returns to rework, and passes on retest.
7. Assert correct WIP, first-pass yield, output counts, queue states, and per-station utilization.
8. Document which entities remain synthetic abstractions and what a real MES/ERP adapter would need to supply.

**Acceptance test:** Given a reproducible demo scenario, a manager can click `WO-xxxx`, see the product revision, its operation plan, actual attempt history, wait/processing/hold time, final quality disposition, and the linked current/last physical workstation. The same timeline must be renderable from a static canonical event fixture with the simulation engine turned off.

---

## 16. Open architectural decisions (do not silently assume)

| Decision | Current direction / questions to resolve |
|---|---|
| Persistence | Start in memory for demo; decide database/backend only after proving second adapter |
| Domain event persistence | Event history + projections; full event sourcing is optional, not required |
| Order fulfillment | Need allocation bridge for many-to-many across customer demand, WOs, serialized units, shipments |
| Serialization | Serialized finished panels likely; component/lot genealogy depends on supplier/source support |
| Clock/time | Simulation UTC instants + explicit simulated time vs site-local display; no wall-clock scheduling in core engine |
| Production scope | Start with discrete, low-volume/high-mix panels; don't abstract for process manufacturing prematurely |
| Simulation granularity | Routing steps and constrained resources, not every physical micro-step |
| Skill/privacy | Use synthetic employee IDs in demo; production policies decided with customer |
| Planning optimizer | Begin with transparent heuristic/rule-based scheduling; validate before complex optimization |
| Real-data freshness | Define capability-specific latency thresholds per integration |
| Integration writeback | Read-only first; no direct industrial equipment controls |
| Feature ownership | Maintain current module boundaries where valid; avoid big-bang rewrite |

---

## 17. What this design is trying to prevent

- A dashboard whose numbers come from mutually inconsistent counters rather than a shared model.
- Beautiful 3D stations that have no stable relationship to real resource IDs.
- A WO that is treated as a serialized physical product.
- A product's current BOM being used to retroactively explain an older manufactured unit.
- Booking material reservations as inventory consumption.
- Treating a snapshot/CDC row as proof of an exact business event time.
- Declaring the busiest workstation the bottleneck without testing system-level constraints.
- Showing “0” for data that is missing or unsupported.
- Predicting precise ship dates without credible material, labor, and calendar inputs.
- Simulated changes leaking into actual-data projections.
- Building hundreds of unused entity classes in anticipation of hypothetical integrations.
- Replacing successful architecture simply to make the code resemble a fashionable enterprise pattern.

---

## 18. Suggested instructions for `CLAUDE.md`

If your repository has a `CLAUDE.md`, add a short instruction rather than duplicating this entire document:

```md
FactoryFlow's product direction, manufacturing domain contracts, real-data
integration requirements, and development roadmap are documented in
`docs/FACTORYFLOW_DESIGN.md`.

Before implementing a substantial new feature, read that file and inspect the
current code. Treat it as an architectural guide rather than a claim that all
features exist. Preserve the separation between simulation, analytics, and
rendering; avoid broad rewrites; implement thin, tested vertical slices; keep
synthetic, observed, and forecast data clearly distinguishable. When design
and existing implementation differ, identify the gap and propose the smallest
safe change.
```

---

## 19. Long-term definition of success

FactoryFlow succeeds if it can:

1. Simulate a plausible manufacturing shop with internally consistent materials, routings, people, work centers, quality, and order flow.
2. Provide a **trustworthy explanation** of production state and trace every metric to the records behind it.
3. Let a manager navigate from site-level KPIs to an individual unit's component and operation history.
4. Quantify the consequences of constraints and compare interventions under controlled assumptions.
5. Replace the simulated data source with a real manufacturer's **partially available and imperfect** operational data while preserving the same core analytical and visualization contracts.
6. Gracefully explain what is known, what is inferred, what is forecast, and what cannot yet be determined.

**Final principle:** Build a manufacturing data and decision platform that happens to include a simulator and 3D visualization—not a 3D simulation that happens to display manufacturing KPIs.
