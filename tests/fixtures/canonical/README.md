# Canonical fixture

Small, committed replay input used by `tests/contract.test.ts`.

- `initial_state.json`: `InitialStateFile` (master data + opening state)
- `events.json`: 60 ordered events covering 19 of 22 event types

Generated with `generateDataset({ seed: "fixture-v1", days: 7, customerOrders: 4, purchaseOrders: 4,
customerCount: 2, assemblyWorkstations: 1, inspectionWorkstations: 1, machineFailuresPerWorkstation: 1,
demandSurge: null })`; event-log hash `fcac9390`.

Outcome: 3 production orders completed (3 + 4 + 2 units), 4 shipments, 9 good units, 100% first-pass yield,
one machine failure with a blocked and resumed operation.

The fixture is a contract: if the "generator parity" test fails, decide whether the generator or the
contract changed. Regenerate the files (and update the golden values in the test) only for an intentional,
documented contract change and bump `SCHEMA_VERSION` when event shapes change.
