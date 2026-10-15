import { availableOf } from "./state.ts";
import type { ManufacturingDataset } from "./types.ts";

/** Output file name (without .json) -> content. Everything derives from master + initial state + events. */
export function buildTables(d: ManufacturingDataset): Record<string, unknown> {
  const s = d.finalState;
  return {
    manifest: d.manifest,
    materials: d.master.materials,
    products: d.master.products,
    bills_of_materials: d.master.billsOfMaterials,
    routings: d.master.routings,
    suppliers: d.master.suppliers,
    customers: d.master.customers,
    workstations: d.master.workstations,
    departments: d.master.departments,
    locations: d.master.locations,
    purchase_orders: Object.values(s.purchaseOrders),
    receipts: Object.values(s.receipts),
    inventory_balances: Object.values(s.inventory).map((b) => ({ ...b, available: availableOf(b) })),
    inventory_transactions: s.inventoryTransactions,
    production_orders: Object.values(s.productionOrders),
    production_operations: Object.values(s.productionOperations),
    workstation_assignments: Object.values(s.workstationAssignments),
    quality_inspections: Object.values(s.qualityInspections),
    downtimes: Object.values(s.downtimes),
    customer_orders: Object.values(s.customerOrders),
    shipments: Object.values(s.shipments),
    events: d.events,
    initial_state: { schemaVersion: d.manifest.schemaVersion, master: d.master, state: d.initialState },
    final_state: d.finalState,
  };
}
