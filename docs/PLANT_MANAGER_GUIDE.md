# FactoryFlow guide for plant managers

How the plant in FactoryFlow works, step by step, what each screen is for, and how every number and event
is calculated. Written for someone who runs or reviews a manufacturing operation, not for a programmer.

> **Everything in this guide describes a synthetic plant.** FactoryFlow runs a deterministic simulation of
> a fictional manufacturer (Larkhaven Controls). The figures, durations, failure rates and supplier
> behaviour are invented to be plausible, not measured. FactoryFlow is an engineering reference
> implementation, not a production-certified MES, ERP, scheduling or control system. Its purpose in a review
> is to make the **logic** visible so you can tell us where it differs from a real plant.

## How to use this guide

- **To learn the app:** read Parts 1 and 2 for the picture, then use Part 4 as a screen-by-screen manual.
- **To review the logic:** read Part 3 (the sequence of events) beside your own process. Each step says what
  the model does, which rules are enforced, and which numbers are assumptions. Part 7 collects the
  assumptions in one table and Part 8 lists questions we would like you to answer.
- **To trace a number:** Part 5 gives the formula, window and "N/A" rule for each metric, with worked examples
  taken from the default dataset. The exhaustive definitions live in [`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md).

Labels used below:

| Label | Meaning |
| --- | --- |
| **Modeled** | The app tracks it and enforces rules about it |
| **Assumed** | A synthetic parameter chosen by us, not measured; a real plant would supply its own |
| **Not modeled** | The app has no data or logic for it; do not infer anything about it from the screens |

Worked examples use the default dataset (seed `larkhaven-2026`, 30 days from Tuesday 2026-09-01). Anyone can
reproduce them: the dataset is deterministic. All times are UTC.

---

## Part 1. The plant in one page

Larkhaven Controls assembles three industrial control panels from purchased parts:

| Product | What it is | Typical build |
| --- | --- | --- |
| **NCP-100** Basic Control Panel | Relay-logic panel, list price $950 | Kit, mount, wire, test |
| **NCP-200** Motor Control Panel | Contactor-based motor starter, $1,890 | Kit, mount, wire, motor-circuit assembly, test |
| **NCP-300** Advanced Automation Panel | PLC and touchscreen HMI panel, $4,650 | Kit, mount, wire, controls configuration, test |

The floor has **receiving docks** (3), **raw-material racks** (4), **six assembly stations**, **three functional
test cells**, and **three shipping bays**, with shared tools (two crimp-and-torque tools, one VFD commissioning
bench, one PLC/HMI programming rig, one hipot tester). Thirteen purchased materials come from five suppliers.
Customers (ten of them) place orders; the plant builds to cover demand that finished-goods stock cannot.

### The flow, in order

```
 Customer order arrives ──▶ Finished goods in stock? ──yes──▶ Allocate to the order ──▶ Ship
          │                          │no                                                 ▲
          │                          ▼                                                   │
          │                 Plan a work order (production order) ──▶ Materials available? │
          │                                                         │no: BLOCKED, wait    │
          │      Purchasing reviews stock ──▶ Purchase order ──▶ Receive ──▶ Put away     │
          │                                                         │yes                  │
          │                                                         ▼                     │
          │                            Release: reserve exact materials (BOM × quantity)  │
          │                                                         ▼                     │
          │                  Start: materials issued, become work in progress (WIP)       │
          │                                                         ▼                     │
          │       Kit ▶ Mount ▶ Wire ▶ (Motor circuit | Controls configuration) ▶ Final test
          │            (stations, shared tools, changeovers; machines can fail)           │
          │                                                         ▼                     │
          │                         Pass ──▶ Finished goods ──▶ Allocate ────────────────┘
          │                         Fail ──▶ Rework once, re-test, or scrap
          └── Dispatch (shipping) is what the model records; it does not record customer receipt
```

Every box is a recorded **event** with a timestamp. The screens are nothing more than different ways of
reading that history. Part 3 walks through each box.

### Three ideas that explain the whole app

1. **The log is the truth.** The plant's state at any moment is produced only by applying events, in order, to
   an opening state. There is no hand-edited number anywhere. Moving the time slider replays the log.
2. **Rules are enforced, not assumed.** A single rulebook rejects impossible events (shipping more than was
   allocated, running a step before the previous one finished, using material that is not in stock). The
   simulation itself proposes events through that same rulebook, so its history cannot break the rules.
3. **Every number has a written definition.** Before a figure appears on screen, its numerator, denominator,
   window and "not available" rule are defined ([`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md)).

---

## Part 2. Time, shifts and the simulated clock

- **Shifts.** New work starts **Monday to Friday, 06:00 to 18:00 UTC**. Operations already started run to
  completion, even past 18:00. Nothing starts on nights and weekends. (**Assumed**: one fixed shift, one
  calendar for the whole plant, no holidays, no overtime.)
- **Daily routines** (working days only): at 06:00 purchasing reviews stock and idle stations are assigned
  work; at 15:00 shipping dispatches orders that are ready.
- **Customer orders** are created between 08:00 and 17:00 on working days.
- **The simulated clock.** The playback toolbar sets how fast simulated time runs (60x to 86,400x). Play, pause,
  reset and the slider all move one clock; every screen reads that same time. A badge shows whether the plant is
  **On shift** or **Off shift** and when the next shift starts.
- **Reporting period** (selector in the header): **Last 24 h**, **Last 7 d** or **Since start**. It sets the
  window for the historical measures (good units, utilization, yield, dispatch rates). Windows are
  *(start, end]*: a record exactly at the start is outside, one exactly at "now" is inside. Measures marked
  "current" ignore the period and describe the moment on the clock.
- **Why "Last 24 h" is sometimes N/A.** The shift-based measures need scheduled shift time in the window. The
  last 24 hours early on a Monday contain none, so utilization shows **N/A** rather than 0%. Choose a longer
  period.

---

## Part 3. The sequence of events, step by step

For each step: what happens on the floor, the events the app records, what changes in the numbers, and
which rules and assumptions apply. Event names are shown in `CODE` style so you can find them in the
Activity feed and work-order timelines. The full event list is in Appendix A.

### 3.1 A customer order arrives

**On the floor.** A customer orders one or two product lines (for example 5 × NCP-100 and 3 × NCP-200) with a due date.

**Events.** `CUSTOMER_ORDER_CREATED`. About 4% of orders are cancelled one to three days later
(`CUSTOMER_ORDER_CANCELLED`), which releases any finished goods reserved for them. Cancellation is allowed only while
the order is open and nothing has shipped.

**What changes.** A new open order appears on the Dispatch tab; its due date starts the clock for on-time measures.

**Assumed.** Demand is random but reproducible: product mix 50% NCP-100, 30% NCP-200, 20% NCP-300; 1 to 6 units
per line; about a third of orders have two lines; due 7 to 14 days after creation, at 17:00 on a working day. A **demand surge** (days 12
to 16 of the default run) multiplies order arrivals by 2.5 and adds campaign orders for NCP-200 (4 to 10 units,
due in 10 to 16 days) from two customers. **Not modeled:** customer priorities, price, contracts, returns.

### 3.2 Finished goods are allocated to the order

**On the floor.** If finished panels are on the shelf, they are reserved for the order's lines.

**Events.** `FINISHED_GOODS_ALLOCATED` (customer order line, quantity, location).

**What changes.** The product's *reserved* quantity rises; *available* (on hand minus reserved) falls. The order's
first-allocation time is recorded; it is the first boundary in the lead-time breakdown (Part 5).

**Rules.** Only available stock can be allocated; a line cannot be allocated more than it still needs.

**Important.** Finished goods are a pool. Stock is allocated to order lines **from the shelf**, not from a
particular work order. So the model cannot say which work order's units went into which customer order. The
Explorer shows work orders "planned for" an order, which is a planning link, not traced unit flow.

### 3.3 Production is planned (a work order is created)

**On the floor.** Planning compares open customer demand for each product with what is already coming
(open work orders) and what is on the shelf. If demand is not covered, it creates a **work order** for the
shortfall.

**Events.** `PRODUCTION_ORDER_CREATED`, which lists the order's routing operations (Part 3.7).

**How the quantity is chosen (assumed policy).** `shortfall = open demand - quantity already in work orders - available stock`.
If the shortfall is 6 or more, 5% (rounded up) is added as a yield allowance. The order is never smaller than the
minimum lot (2 units). Planning runs whenever a customer order is created and whenever finished goods are received. If demand disappears (an order is
cancelled), work orders that have not started and are no longer needed are cancelled (`PRODUCTION_ORDER_CANCELLED`).

**Which order lines it is planned for.** Open order lines are taken oldest customer order first, the same order
stock is allocated in. Stock on the shelf and quantities already in work orders cover the first lines; the new work
order is linked only to the lines that cover does not reach (a line that is only partly covered is linked to both
the earlier work order and the new one). So a work order usually serves one or two lines, and an order line is
linked to at most two work orders.

**What changes.** The Work Orders tab shows a new row in status *Planned*. The work order's due date is the
earliest due date among the order lines it was planned for.

**Not modeled:** capacity-aware scheduling, promised dates, batching across products, safety stock of finished goods.

### 3.4 Purchasing, receiving and put-away (runs in parallel)

**On the floor.** At 06:00 on working days purchasing reviews each supplier's materials against a target cover. Each supplier is reviewed on a repeating cycle of a few working days (the cycle is chosen so a run raises roughly the target number of purchase orders; at the default settings it is every working day).

**Events.** `PURCHASE_ORDER_CREATED`, then `MATERIAL_RECEIVED` when goods arrive at a receiving dock, then
`INVENTORY_TRANSFERRED` (put-away) from the dock to the material's raw-material rack.

**The reorder rule (assumed policy).** For each material:

- *Position* = usable stock in raw storage + quantity still to arrive on open purchase orders − what planned
  but unreleased work orders will need.
- *Target* = average daily usage × (supplier lead time + review cycle + safety days).
- Order when the position falls below *target − half a review cycle of usage*. The order quantity brings the
  position back up to the target, rounded up to the material's order multiple.

**Supplier behaviour (assumed).** Each supplier has a lead time (4 to 12 days) and an on-time rate (65% to 92%);
the least reliable supplies the PLC CPU and HMI display for the advanced panel. A late delivery is 1 to 5 days
late for a recorded reason (carrier delay, supplier stock-out, customs hold), and 40% of late deliveries arrive
in two parts (about 60% first, the rest two to four days later). The planner never sees this ahead of time.

**What changes.** Stock sits on the dock (counted on hand, **not** available for production) until it is put
away to a rack. The Inventory and Material Shortages tabs show on-order quantities and promised dates.

**Rules.** A receipt cannot exceed what was ordered. Reserved stock cannot be transferred.
**Not modeled:** incoming quality hold, substitutes, price changes beyond a small per-order variance, supplier
invoices, lot or serial numbers of purchased parts.

### 3.5 Release, and the material-shortage block

**On the floor.** A planned work order is released only if **every** bill-of-materials line can be reserved in full.
Partial release is not allowed.

**Events.**

- Enough stock: `PRODUCTION_ORDER_RELEASED` reserves exactly *BOM quantity × work-order quantity* of each material
  in raw storage. The order is now *Released* and waits for a station.
- Not enough stock: `PRODUCTION_BLOCKED` (reason `MATERIAL_SHORTAGE`) lists which materials are short, how much
  is available, and which open purchase orders are expected to cover the gap. The order is *Blocked*.
- When stock arrives and is put away, blocked orders are retried (earliest due date first) and released.

**What changes.** Reserved quantities rise; available falls. The dashboard's *Blocked by material shortage* count,
the Material Shortages tab and the 3D "Material shortage" overlay all describe the same set of orders.

**Rules.** Availability is on hand minus reserved **in raw-storage racks only**. Material still on a receiving dock cannot be
reserved. Competing orders do not split stock: the order at the front of the retry list gets it.

### 3.6 Start: materials are issued and become work in progress

**On the floor.** When a station is free, the work order starts: its reserved materials leave the rack and move to the
station.

**Events.** `MATERIAL_CONSUMED` and `PRODUCTION_STARTED`, at the same instant.

**What changes.** This is the moment raw material becomes **work in progress (WIP)**. Until the order's units are received
into finished goods or scrapped, they count in the WIP figure.

**Rules.** Material is never issued without a reservation. WIP is conservation-checked: an order can close only when every
unit is accounted for as good, scrapped or received.

### 3.7 The routing: operations, stations, tools and changeovers

**On the floor.** Each product has a routing of steps. Each step belongs to a **work center** (a capability such as
wiring), and a work center is served by one or more **stations**:

| Work center | Stations that serve it |
| --- | --- |
| Kitting | Kitting, Flex Assembly |
| Mechanical assembly | Mechanical Assembly, Flex Assembly |
| Wiring and termination | Wiring and Termination A, Wiring and Termination B, Flex Assembly |
| Motor-control setup | Controls and Motor Setup, Flex Assembly |
| Controls configuration | Controls and Motor Setup, Flex Assembly |
| Functional test | Functional Test A, B and C |

A step runs on **any idle station that serves its work center**, so a work order can move between stations. Each station
runs one job at a time. Steps run strictly in sequence: a step cannot start until the previous one is complete.

**Standard times (assumed).** Planned minutes = setup + minutes per unit × quantity:

| Step | NCP-100 | NCP-200 | NCP-300 |
| --- | --- | --- | --- |
| Kit | 5 + 5/unit | 5 + 5/unit | 10 + 10/unit |
| Mount | 5 + 8/unit | 5 + 10/unit | 15 + 15/unit |
| Wire | 10 + 12/unit | 10 + 15/unit | 15 + 30/unit |
| Motor-circuit assembly | | 15 + 20/unit | |
| Controls configuration | | | 30 + 35/unit |
| Final test | 10 + 8/unit | 10 + 12/unit | 15 + 20/unit |

**Station speed and variation (assumed).** Each station has a speed factor (1.00 to 1.33, slower stations take
proportionally longer), and each run varies randomly between 92% and 112% of its planned duration.

**Shared tools.** Some steps need a tool for the whole operation, including while their station is down: wiring needs a
crimp-and-torque tool (two exist), motor-circuit assembly the VFD bench, controls configuration the PLC/HMI rig, and
the NCP-200 and NCP-300 final tests the hipot tester (only one, shared by all three test cells). A step cannot start if no unit of the
required kind is free. This is the "waiting on equipment" condition.

**Changeovers (assumed).** Setup depends on what the station ran last at that work center. A repeat of the same product pays
40% of the standard setup (at least 2 minutes); switching pays the new product's standard setup plus 5 minutes per
complexity level going up and 2 going down (NCP-100 = 1, NCP-200 = 2, NCP-300 = 3). Rework is exempt.

**Who is chosen next (assumed dispatch rule).** When a station is idle and the plant is in shift: rework first; then work
already in progress before releasing a new order into kitting; then earliest due date; then step order.

**Events.** `OPERATION_STARTED` (with the setup minutes actually applied, the previous product if there was a changeover, and
the tools taken) and `OPERATION_COMPLETED`. When the last assembly step finishes, `PRODUCTION_COMPLETED`: units now wait
for functional test (they are still WIP).

**What changes.** Work-center queues, station status, utilization and the 3D station colours. Operations that are ready but
not yet picked up are the **queue** at that work center.

### 3.8 A machine fails

**On the floor.** Each assembly station has two failures in the default run, on working days at least two days apart, each
needing 60 to 300 minutes to repair (**assumed**).

**Events.** `MACHINE_FAILED`; if a step is running, it pauses and `PRODUCTION_BLOCKED` (reason `MACHINE_DOWN`) is recorded;
later `MACHINE_RESTORED` and `PRODUCTION_RESUMED`. The step resumes with the time it had left.

**What changes.** The station shows **Down**; time paused is recorded on the step as *hold*; utilization excludes it.
Units of a work order whose assembly was interrupted are three times as likely to fail first-pass test (Part 3.9), and a failed
inspection points back at the downtime that probably caused it.

**Not modeled:** preventive maintenance, spare parts, technicians, partial failures, quality drift.

### 3.9 Final test: pass, rework or scrap

**On the floor.** Every unit is tested at a functional test cell.

**Events.** `QUALITY_INSPECTION_COMPLETED` (units inspected, passed, sent to rework, scrapped, defect codes, and the cause if
one is recorded), then `OPERATION_COMPLETED` for the test step.

**How units fail (assumed).** Each unit fails with its product's base rate (NCP-100 2%, NCP-200 4%, NCP-300 7%), tripled if
the order's assembly was interrupted by a machine failure. Each failed unit gets one defect code (wiring error, loose
termination, functional test fail, enclosure damage). A failure is **reworked** unless it is enclosure damage, which is **scrapped**.

**Rework.** `REWORK_REQUESTED` adds two steps: a rework step on an assembly station (10 minutes setup + 25 per unit) and a
re-test. The re-test failure rate is half the first-pass rate, and any unit that fails the re-test is **scrapped**: a unit is
reworked at most once.

**What changes.** First-pass yield, rework and scrap rates, the defect Pareto and WIP. Scrapped units leave WIP.

### 3.10 Good units enter finished goods

**Events.** `FINISHED_GOODS_RECEIVED` records exactly the quality-approved units; it is allowed only when all steps are
complete and no units are still waiting for test or rework. The work order becomes *Completed*. After a receipt the plant
allocates finished goods to waiting orders and plans any further production.

**What changes.** *Good units produced* counts here: **at the time of the receipt**, not when the panel was built.
(In this model the receipt happens at the instant the last test step completes.)

### 3.11 Shipping (dispatch)

**On the floor.** Every working day at 15:00 the plant ships orders that have allocated stock.

**Events.** `SHIPMENT_DISPATCHED`: the shipment, its carrier and lines. A shipment cannot exceed what was allocated to a line.

**Policy (assumed).** An order ships when everything allocated covers it completely, **or** when its due date is within a day or already
past (a partial shipment). So a partial shipment means the order was nearly late or late. The balance ships later.

**What changes.** The order becomes *Partially dispatched* or *Dispatched*. All delivery-type measures are **dispatch** measures:
the model records when goods leave, not when the customer receives them, and it does not know transit time.

### 3.12 What the rulebook guarantees

- **Inventory** has three quantities per item per location: on hand, reserved, available (= on hand − reserved), and
  `0 ≤ reserved ≤ on hand` is enforced on every movement, so available can never go negative.
- **An event that breaks a rule is rejected** and changes nothing (it does not leave a half-applied state).
- **Replay is reproducible.** The same starting state and the same events always produce the same plant. The same
  seed and configuration always produce the same event log (checked by a hash).
- **Nothing is invented for missing data.** If a source cannot state something, it stays unknown rather than being shown as zero.

---

## Part 4. Using the app, screen by screen

### 4.1 Factory Overview

**Use it to:** see the plant as a whole, spot where work is piling up, and move through time.

- **Playback toolbar.** Play or pause, reset, choose a speed, drag the slider. The badge shows On shift / Off shift.
- **KPI cards (six).** Good units produced, work in progress, active production orders, workstation utilization, first-pass
  quality yield, blocked by material shortage. Hover a card for its definition. Formulas in Part 5.1.
- **3D plant.** Orbit, pan, zoom, click a station or rack. Station colours: grey idle, green running, amber blocked
  (idle assembly station while orders wait on material), red down. Racks are coloured by pallet fill. Boxes in front of the assembly lanes
  are the **queue**: one box per waiting work order, height = units, amber pad = the bottleneck candidate, faded when
  off shift.
- **Colour by.** Recolours stations or racks by *Queue*, *Utilization* or *Material shortage*. Dark objects are not highlighted;
  light blue to bright is low to high. Each uses the same number as the corresponding table (Part 5.5).
- **Station panel.** Click a station for its status, current work order, queue and utilization, with a button to open that work order.
- **Workstation table and Activity feed.** Status, current order, queue and utilization per station; the latest events in plain words. Click a row or an
  event to focus the station.

**Read with care:** the KPIs are *as of the simulated clock*; change the reporting period and the historical KPIs change. A queue box is a
ready step that no station has picked up; off shift it is waiting for the shift, not for a station.

### 4.2 Operations Explorer

A full-page reporting view over the same clock and the same records. Seven tabs plus drawers.

#### Work Orders

**Use it to:** answer "where is this order, how long did each stage take, and why did it take that long?"

- The list shows every work order created so far, with status (Planned, Released, Running, Blocked for material or machine,
  Completed, Cancelled), current operation and progress. Search by work order, product or customer order; filter by status.
- **Work-order drawer** (click a row). Order summary; **Elapsed time**; **Contributing conditions**; routing with wait, run and hold
  per step; material requirements; quality history; event timeline.
- **Elapsed time** splits the order's whole life into mutually exclusive categories that add up to the total:

| Category | The order was... |
| --- | --- |
| Before release | created, waiting to be released (and not blocked) |
| Blocked: material shortage | blocked because a material was short |
| Held: machine down | paused because its station was down |
| Processing | running on a station (includes setup and rework) |
| Waiting to start (in shift) | released with a step ready but no station started it, during a shift |
| Waiting to start (off shift) | the same, outside a shift |
| After last operation, before receipt | all steps done, not yet received (zero in this model) |
| Unclassified | something the model cannot place (zero in this data) |

- **Flow time** = completed − created. **Cycle time** = completed − released.
- **Contributing conditions** are things that may have affected the wait. They **overlap**, so they are never added up and are not causes:
  material shortage time, whether a station serving the next step was down while it waited, off-shift time, changeover setup, and (for open orders)
  whether equipment is free and where the order sits in the queue *right now*.

**Read with care:** a work order's delay is often "blocked for material" (days) while its shop-floor cycle is hours. The two are different
measures on purpose (Example 2 below).

#### Dispatch

**Use it to:** see which customer orders are late or going to be, how long orders take to ship, and whether you ship on time and in full.

- **Cards:** On-Time In-Full Dispatch, Quantity Fill by Due Date, On-Time Dispatch Rate, Past-Due Unshipped Orders, Order-to-Final-Dispatch Lead Time (median and P90).
- **Past-due table** (when any): the most overdue unshipped orders first, with the units still owed.
- **Customer orders table**, ordered past-due first, then open orders by earliest due date, then dispatched. Click a row for the **customer-order drawer**:
  order summary, lines, work orders planned for it, finished-goods allocations, and shipments (each marked on time or after the due date).

**Read with care:** this is dispatch, not delivery; the due date is treated as dispatch-by; the link to work orders is a planning link.

#### Quality

**Use it to:** see where units are lost to rework and scrap and what kind of defects dominate.

- Cards: first-pass yield, rework rate, scrap rate, re-test pass rate, defective units. Then a **defect Pareto**, failed units **by recorded cause** (machine failure,
  process variation, not recorded), and tables **by product** and **by test station**. Sample sizes are shown next to every rate, so a rate over a handful of units
  is visibly a small sample.

#### Material Shortages

**Use it to:** know which work orders are held for material, what exactly is short, and whether supply is coming.

- For each blocked work order: the short material, quantity required, available now, shortfall, and the open purchase orders that would cover it ("Covered by <date>",
  "Not covered", or "No supply on order"), plus how long the order has been blocked, the customer orders it was planned for, and a "Show racks" link to the 3D plant.
- **By material:** how many blocked orders each short material affects, stock now, quantity on open POs and the earliest promised date.

**Read with care:** blocked orders compete for the same stock and supply, and nothing is allocated between them here. **Do not add shortfalls across orders.** A promised
date is the supplier's promise, not a forecast; the model also records late and part deliveries.

#### Production Analytics

**Use it to:** see output over time. One chart of good units per hour (or per day for longer windows), by product or all products.

#### Work Centers

**Use it to:** see where WIP is waiting, which tools limit flow, and what surrounds the bottleneck candidate.

- A table per work center: stations, units in process, queued orders and units, queued standard minutes per station, waiting on equipment, oldest wait, setup minutes and
  changeovers, utilization. A banner appears off shift.
- The **bottleneck candidate** is the work center with the most queued standard minutes per serving station. It is never flagged off shift (nothing can start, so a queue says
  nothing about capacity).
- **The "Why" card** lists conditions around the flagged work center in three groups (right now, over the period, whole plant) as independent observations. A filled dot
  means a yes/no condition is present. Off shift it shows the largest queue and says it is not flagged.
- **Equipment table:** each shared tool, who holds it, its utilization and how many ready steps are waiting for it.

**Read with care:** the flag marks *where WIP waits*, not *why*. A long queue can come from lane capacity, a failure upstream, or a burst of releases.

#### Bill of Materials

Per product: components, quantity per unit, unit cost, extended cost, supplier and lead time. The total equals the product's standard cost.

#### Inventory

**Use it to:** see what stock exists and where.

- **By location:** pallets used, capacity and fill for each dock, rack, station area and shipping bay.
- **By item:** on hand, reserved, available, quantity on order and earliest promised date, whether a blocked work order is short of it, and where it sits.

### 4.3 Moving between views

- Customer order to its work orders and back, from either drawer; a Back button returns to the previous record.
- **Show in factory** (work-order and customer-order drawers), **Show racks** (Material Shortages) and **Show** (Inventory) select the object in the 3D plant.
- The address bar records the view, tab and selected record, for example `#/explorer/orders/WO-0040` or `#/explorer/dispatch/CO-0008`, so a link can be shared. It does not record the
  simulated time, so a record that does not exist yet at the current time shows "does not exist at the selected simulation time".

---

## Part 5. How the numbers are calculated

All durations are held exactly and rounded only for display. Money is whole cents. A "window" below is the reporting period, *(start, end]*.

### 5.1 The six dashboard KPIs

| KPI | Calculation | Window | N/A when |
| --- | --- | --- | --- |
| Good units produced | Σ units received into finished goods, for work orders whose completion falls in the window | period | never (0 is a real count) |
| Work in progress | Σ units issued to production and not yet received or scrapped, over all work orders | now | never |
| Active production orders | count of work orders Released, Running or Blocked | now | never |
| Workstation utilization | Σ busy minutes ÷ (stations × scheduled shift minutes). Busy = step run time minus machine-down time, capped at the shift per station | period | no shift minute elapsed |
| First-pass quality yield | Σ passed ÷ Σ inspected, first-round inspections in the window | period | no first inspection in the window |
| Blocked by material shortage | count of work orders Blocked for a material shortage | now | never |

### 5.2 Dispatch and lead time

*Order-to-final-dispatch lead time* = the dispatch that completes the order − order creation, for fully dispatched orders. It is split into three consecutive,
exclusive segments that add up exactly: creation to first allocation, first allocation to first dispatch, first dispatch to final dispatch (zero for a single shipment).
*Dispatch lateness* = max(0, final dispatch − due date). *Past-due unshipped* = open or partly dispatched orders whose due date has passed. *Time to due date* = due date − now for open orders not yet due (arithmetic, not a forecast).

*On-Time In-Full Dispatch* = orders fully dispatched on or before the due date ÷ orders **due in the window and already due** (cancelled orders excluded). Because the group is chosen by due date,
an order still unshipped after its due date counts as late; a partly dispatched order does not count as in full. *Quantity Fill by Due Date* = units dispatched on or before the due date ÷ units ordered, same orders.
*On-Time Dispatch Rate* = shipments in the window dispatched on or before their order's due date ÷ shipments in the window (each shipment once). Lead-time median and P90 use the nearest-rank method over orders whose final dispatch is in the window.

N/A: a rate is N/A (not 0) when its group is empty; lead time is N/A until an order is fully dispatched.

### 5.3 Work-order time

Defined per work order, from its own events, between creation and completion (or "now" if still open). At every instant exactly one category applies, chosen by the order's state:

- *Before release*: not released and not blocked. *Blocked: material*: blocked for a shortage. *Held*: a step is paused by a machine failure. *Processing*: a step is running.
- *Waiting to start*: released, not blocked, nothing running, and at least one step is still open (including requested rework steps); split into in-shift and off-shift by the shift calendar.
- *After last operation, before receipt*: every step done, nothing owed to test or rework, not yet received.
- *Unclassified*: anything else, shown rather than hidden.

The categories always add up to the elapsed time exactly (a test checks this for every work order). The drawer's per-step **wait** counts in-shift minutes from release or the previous step's end to the
next start; it equals the in-shift *Waiting to start* time for waits that ended in a start, up to whole-minute rounding, and it does not count a wait still in progress or off-shift time.

### 5.4 Quality

First-pass yield = first-round passed ÷ first-round inspected. Rework rate = first-round units sent to rework ÷ first-round inspected. Scrap rate = units scrapped at any inspection in the window ÷ first-round
units inspected in the window (a re-test scrap in the window can belong to units first inspected earlier). Re-test pass rate = re-test passed ÷ re-tested. The Pareto sums defect codes over all inspections in the window;
cause is shown only where the record states one, otherwise "not recorded".

### 5.5 Work centers, shortages, inventory and overlays

- **Queue at a work center:** work orders whose next step belongs to it, ready (previous steps done, order released) and not started. *Queued standard minutes* = Σ planned minutes of those steps; per station = ÷ serving stations.
  *Oldest wait* = shift minutes since the oldest queued step became ready. *Utilization* = run time excluding failure holds ÷ (serving stations × shift minutes).
- **Material shortage:** required = BOM quantity × work-order quantity; available now = on hand − reserved in raw storage; short by = required − available. Supply status: *covered* when open POs, taken in promised-date order, first reach the shortfall by that
  PO's promised date; *not covered* when open supply is smaller; *no supply on order* when none exists.
- **Inventory:** pallets used rounds each item up to whole pallets; available as above; finished goods available = on hand − reserved for customer orders.
- **Overlays:** *Queue* highlights stations with at least one order waiting (the station table's queue column); *Utilization* highlights stations with a utilization figure for the chosen period; *Material shortage* highlights the racks
  holding materials that blocked work orders are short of. Intensity is the value scaled to the largest on screen.

### 5.6 Worked examples (default dataset)

**Example 1: one customer order's lead time (CO-0008).** Birchwood Water Utilities ordered 4 × NCP-300 and 6 × NCP-100, created Wed 2026-09-02 09:09, due Mon 2026-09-14 17:00. Finished goods were first allocated at 15:34 the same day
and everything dispatched Thu 2026-09-03 15:00. Lead time = 1,791 min (1 day 5 h 51 min), split 385 min (creation to allocation) + 1,406 min (allocation to dispatch) + 0 (single shipment) = 1,791. Dispatched 11 days before the due date, so lateness is 0 and the order counts as on time and in full. The drawer lists two work orders "planned for" it,
one per line: WO-0007 (7 × NCP-100 for line 2) and WO-0008 (4 × NCP-300 for line 1). It is still a planning link, not a unit trace: the units came from the shared finished-goods shelf.

**Example 2: one work order's time (WO-0040, 7 × NCP-300).** Created Mon 2026-09-07 16:42 and completed Tue 2026-09-15 16:40: flow time 11,518 min. Of that, 9,810 min was *Blocked: material* (waiting for PLC CPUs and HMI displays, Example 3),
1,055 min *Processing*, 153 min *Waiting to start (in shift)* and 500 min *Waiting to start (off shift)*; 0 elsewhere, including *Held: machine down*. 9,810 + 1,055 + 153 + 500 = 11,518. Its cycle time (released to completed) is only 1,708 min (28 h 28 min). The routing view shows
kit 80 min, mount 53 min wait / 173 run, wire 262, controls configuration 296, test 172; one of seven units failed first-pass test (loose termination), so rework (83 wait / 43 run) and a re-test (17 wait / 29 run) followed and that unit passed. The drawer's step waits (53 + 83 + 17 = 153 min) match *Waiting to start (in shift)*; its processing
steps add to 1,055.

**Example 3: a shortage (WO-0040 at Fri 2026-09-11 17:00).** The 7-unit NCP-300 order needs 7 PLC CPUs and 7 HMI displays (one each per panel); the rack holds 1 of each, so it is short by 6 of each. Purchase order PO-0003 covers both, promised Mon 2026-09-14 10:00, so the status is
"Covered by Mon 2026-09-14 (PO-0003)". Twelve other work orders are blocked on the same two parts at that moment, which is why shortfalls must not be added.

**Example 4: whole-run figures (Since start, end of the 30 days).** Good units 797. Utilization 47.0% = 66,952 busy min ÷ 142,560 (9 stations × 15,840 shift min; the 22 working days of September at 720 min). Controls & Motor Setup reached 74% (11,682 ÷ 15,840), Wiring & Termination A 72%, and the second test cell 10%.
First-pass yield 96.0% = 768 ÷ 800 units; rework rate 3.6% (29 units); scrap rate 0.4% (3 units). On-Time In-Full Dispatch 89.6% (112 of 125 orders due); quantity fill 88.5% (586 of 662 units); median lead time 3 d 2 h 44 min, P90 11 d 6 h 31 min; 7 orders past due and unshipped at the end.

---

## Part 6. What a real plant would do differently

The model is deliberately simple. Differences you would expect, none of which the app represents today:

- Multiple shifts, overtime, holidays, breaks, and people (skills, absences, assignments). **Not modeled.**
- Scheduling that looks ahead: finite-capacity plans, promised dates, priorities, expediting. The app uses simple rules (earliest due date). **Not modeled.**
- Unit or lot genealogy (which serial number went into which order). **Not modeled**; this is why the order-to-work-order link is a planning link.
- Incoming inspection, quarantine, supplier returns, substitutes, partial receipts beyond the simple split. **Not modeled.**
- Customer receipt, transit, returns and claims. **Not modeled**; delivery metrics are dispatch metrics.
- Costs beyond standard material cost: labour, overhead, scrap cost, inventory value. **Not modeled.**
- Forecasts and predictions of any kind (late-order risk, lead-time estimates). **Not modeled**: every figure is an observed fact about the past.

---

## Part 7. Assumptions in one table

These synthetic parameters shape every result. They live in `src/manufacturing/masterData.ts` and `generator.ts`; a real plant would replace each with its own data.

| Area | Assumption | Value |
| --- | --- | --- |
| Calendar | One shift, working days only | Mon to Fri 06:00 to 18:00 UTC |
| Demand | Product mix | 50% NCP-100, 30% NCP-200, 20% NCP-300 |
| Demand | Order size, lines, due date | 1 to 6 units per line; about a third have two lines; due in 7 to 14 days |
| Demand | Surge | Days 12 to 16, arrivals ×2.5, NCP-200 campaigns of 4 to 10 units |
| Demand | Cancellations | About 4%, one to three days after creation |
| Planning | Yield allowance and lot | +5% when shortfall ≥ 6; minimum 2 units |
| Purchasing | Reorder rule | Target = daily usage × (lead time + review cycle + safety days); order below target minus half a cycle |
| Suppliers | Lead time, on-time rate | 4 to 12 days; 65% to 92% |
| Suppliers | Late delivery | 1 to 5 days; 40% arrive in two parts |
| Routings | Setup and minutes per unit | Table in Part 3.7 |
| Stations | Speed factor, run variation | 1.00 to 1.33; 92% to 112% of planned |
| Tools | Shared tools | 2 crimp tools, 1 VFD bench, 1 PLC rig, 1 hipot tester |
| Changeover | Repeat / switch | 40% of standard (min 2); target setup + 5 per level up, 2 per level down |
| Failures | Machine failures | 2 per assembly station, 60 to 300 min repair |
| Quality | Base defect rate | 2% / 4% / 7%; ×3 after an interrupted assembly; ×0.5 on re-test |
| Quality | Rework | 10 min setup + 25 min per unit, once; enclosure damage scrapped |
| Shipping | Dispatch time and rule | 15:00 on working days; ship when complete, or when due within a day |

---

## Part 8. Questions for reviewers from a manufacturer

We would like to know where this differs from a plant you know. Short answers are fine.

**Flow and rules**
1. Is the order of steps right (demand, allocate from stock, plan, buy, release only if all materials are reservable, issue at start, build in sequence, test, rework once or scrap, receive, ship)? Where does your plant differ?
2. Do you release a work order only when every part is available, or start with partial kits? How do you handle the shortage case?
3. Is "material becomes WIP when issued at start" the right moment in your accounting? When do you consider a unit scrapped or reworked?
4. Do you allocate finished goods from a pool, or reserve specific lots or serial numbers to customer orders?

**Time and capacity**
5. Are the shift assumptions (one shift, nothing starts off shift, started work finishes) reasonable for your plant, and how do you treat overtime?
6. Do step times, setups and changeovers behave like ours (setup plus per-unit time, cheaper repeat runs, dearer switches)? Which do you actually measure?
7. Which shared tools or fixtures typically limit flow in your plant, and do they stay held while a station is down?

**Measures**
8. Do you define on-time as dispatch-by or delivery-by? Is "in full" the whole order or per line? How do you treat partial shipments?
9. Is first-pass yield for you units passing the first test over units tested (our definition)? How do you count rework and scrap rates?
10. Is "utilization = run time ÷ scheduled shift time, excluding downtime" how you measure it? What do you exclude (breaks, changeovers, planned maintenance)?
11. Is the bottleneck candidate "most queued standard minutes per serving station" a useful signal? What would you look at instead?
12. Which numbers on these screens would you act on, which would you ignore, and what is missing?

**Data**
13. Which of the events in Appendix A does your MES, ERP or WMS record, with what timestamps and identifiers? Which are missing or only approximate?
14. Do the statuses and reasons (blocked for material or machine, defect codes, delay reasons) match how your people classify things?

---

## Appendix A. The event catalog

Every change in the app is one of these 22 events, recorded with a sequence number, a timestamp, the records it touches and its details. In a real plant, the right-hand column
suggests where such a record would typically originate; this is orientation, not a statement about any particular system.

| Event | What it means on the floor | Typically recorded by |
| --- | --- | --- |
| `CUSTOMER_ORDER_CREATED` | A customer order is entered | ERP / order management |
| `CUSTOMER_ORDER_CANCELLED` | The customer cancels before anything shipped | ERP |
| `FINISHED_GOODS_ALLOCATED` | Finished stock is reserved for an order line | ERP / WMS |
| `PRODUCTION_ORDER_CREATED` | A work order and its routing steps are planned | ERP / MES planning |
| `PRODUCTION_ORDER_RELEASED` | Materials are reserved and the order is released to the floor | ERP / MES |
| `PRODUCTION_ORDER_CANCELLED` | An unstarted work order is cancelled; reservations return | ERP / MES |
| `PRODUCTION_BLOCKED` | The order cannot proceed (material short, or machine down) | MES |
| `PRODUCTION_RESUMED` | A paused step continues after repair | MES |
| `PURCHASE_ORDER_CREATED` | A purchase order is raised | ERP / purchasing |
| `MATERIAL_RECEIVED` | Goods arrive at a receiving dock | WMS / receiving |
| `INVENTORY_TRANSFERRED` | Goods move between locations (put-away) | WMS |
| `MATERIAL_CONSUMED` | Reserved materials are issued to the order and become WIP | MES / ERP backflush or issue |
| `PRODUCTION_STARTED` | The work order starts on a station | MES |
| `OPERATION_STARTED` | A routing step starts (setup, tools, previous product) | MES / operator terminal |
| `OPERATION_COMPLETED` | A routing step finishes | MES / operator terminal |
| `PRODUCTION_COMPLETED` | All assembly steps are done; units await test | MES |
| `QUALITY_INSPECTION_COMPLETED` | Test result: passed, rework, scrap, defect codes | MES / QMS |
| `REWORK_REQUESTED` | Failed units need a rework step and a re-test | MES / QMS |
| `FINISHED_GOODS_RECEIVED` | Approved units move into finished goods | MES / WMS |
| `SHIPMENT_DISPATCHED` | A shipment leaves | WMS / shipping |
| `MACHINE_FAILED` | A station goes down | MES / maintenance system |
| `MACHINE_RESTORED` | The station is back | MES / maintenance system |

## Appendix B. Identifiers and vocabulary

| Term | Meaning |
| --- | --- |
| Work order | A production order: a batch of one product built to cover demand (`WO-0040`) |
| Customer order | An order from a customer, with lines and a due date (`CO-0008`); lines carry the quantities |
| Purchase order | An order to a supplier (`PO-0003`) |
| Work center | A capability (wiring, test) served by one or more stations |
| Station | One machine or bench that runs one job at a time (`ASM-003`, `QC-001`) |
| Routing | The ordered steps for a product |
| Changeover | Extra or reduced setup depending on the product the station ran last |
| WIP | Units issued to production and not yet received into finished goods or scrapped |
| Reserved / available | Reserved = promised to an order; available = on hand minus reserved |
| Queue | Steps that are ready but not yet started anywhere |
| Dispatch | A shipment leaving the plant (the model has no customer-receipt data) |
| Planning link | The link from a customer order to the work orders created for it; not unit traceability |
| Synthetic data | Invented by a deterministic simulation, plausible but not measured |
| Event | One recorded change, with a time and the records it touches; the app's only source of truth |

*Companion documents:* [`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md) (every metric, with limitations), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how data reaches each screen),
[`STATUS.md`](STATUS.md) (what exists today), [`REDUCER_RULES.md`](REDUCER_RULES.md) (every business rule), and [`../src/manufacturing/README.md`](../src/manufacturing/README.md) (the data model).
