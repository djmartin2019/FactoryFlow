/**
 * Inventory by location and by item (slice S7-lite). Semantics: docs/KPI_DEFINITIONS.md ("Inventory by location and material").
 *
 * It composes existing definitions instead of recomputing stock: pallet fill comes from `inventoryByLocation`, and the "available for
 * release" figure and the short flag come from `materialShortages`' rules (on hand minus reserved in raw storage; blocked work orders
 * short of the material). Observed facts as of the snapshot time; no days-of-supply, reorder or forecast figure exists in the model.
 */
import { inventoryByLocation } from "../manufacturing/selectors.ts";
import type { FactoryState, Id, ItemKind, LocationKind } from "../manufacturing/types.ts";
import { materialShortages } from "./materialShortages.ts";
import type { ReportingSnapshot } from "./types.ts";

export interface LocationStock {
  locationId: Id;
  name: string;
  kind: LocationKind;
  palletsUsed: number;
  palletCapacity: number;
  /** palletsUsed / palletCapacity (0 when the location has no capacity); can exceed 1. */
  fill: number;
  /** Distinct items with stock on hand here. */
  itemsStocked: number;
}

export interface ItemStock {
  itemId: Id;
  kind: ItemKind;
  sku: string;
  description: string;
  uom: string;
  /** Σ on hand over every location. */
  onHand: number;
  /** Σ reserved over every location. */
  reserved: number;
  /**
   * What can be reserved right now. Raw materials: on hand minus reserved in raw-storage locations only (the release rule, identical to the
   * Material Shortages tab's "available now"; stock still on a receiving dock cannot be reserved). Finished goods: on hand minus reserved.
   */
  available: number;
  /** Locations holding stock of this item, with the quantity on hand. */
  locations: Array<{ locationId: Id; onHand: number }>;
  /** Raw materials: outstanding quantity (ordered minus received) on open purchase orders. Null for finished goods. */
  openPurchaseOrderQuantity: number | null;
  /** Raw materials: earliest promised delivery among open purchase orders; null if none or finished goods. */
  earliestPromisedMs: number | null;
  /** True when at least one blocked work order is short of this material right now. */
  short: boolean;
  /** Blocked work orders short of this material (0 unless `short`). */
  blockedOrders: number;
}

export interface InventoryReport {
  asOfMs: number;
  locations: LocationStock[];
  /** Every master raw material, then every finished good, including items with nothing on hand. */
  items: ItemStock[];
}

export function inventoryReport(snapshot: ReportingSnapshot): InventoryReport {
  const { state, master, asOfMs } = snapshot;
  const byLocation = inventoryByLocation(state as FactoryState, master);
  const locationKind = new Map(master.locations.map((l) => [l.id, l.kind]));
  const shortages = materialShortages(snapshot);
  const shortCount = new Map(shortages.byMaterial.map((m) => [m.materialId, m.blockedOrders]));

  // Open purchase-order supply for every material (not only short ones).
  const outstanding = new Map<Id, { qty: number; earliest: number }>();
  for (const po of Object.values(state.purchaseOrders)) {
    if (po.status === "RECEIVED") continue;
    const promised = Date.parse(po.promisedDeliveryAt);
    for (const l of po.lines) {
      const open = l.orderedQuantity - l.receivedQuantity;
      if (open <= 0) continue;
      const cur = outstanding.get(l.materialId);
      outstanding.set(l.materialId, { qty: (cur?.qty ?? 0) + open, earliest: cur ? Math.min(cur.earliest, promised) : promised });
    }
  }

  const locations: LocationStock[] = master.locations.map((loc) => {
    const inv = byLocation[loc.id];
    return {
      locationId: loc.id,
      name: loc.name,
      kind: loc.kind,
      palletsUsed: inv.palletsUsed,
      palletCapacity: inv.palletCapacity,
      fill: inv.utilization,
      itemsStocked: inv.items.length,
    };
  });

  const stockOf = (itemId: Id, kind: ItemKind) => {
    const balances = Object.values(state.inventory).filter((b) => b.itemId === itemId && b.itemKind === kind);
    let available = 0;
    for (const b of balances) if (kind === "FINISHED_GOOD" || locationKind.get(b.locationId) === "RAW_STORAGE") available += b.onHand - b.reserved;
    return {
      onHand: balances.reduce((n, b) => n + b.onHand, 0),
      reserved: balances.reduce((n, b) => n + b.reserved, 0),
      available,
      locations: balances.filter((b) => b.onHand > 0).map((b) => ({ locationId: b.locationId, onHand: b.onHand })).sort((a, b) => a.locationId.localeCompare(b.locationId)),
    };
  };

  const items: ItemStock[] = [
    ...master.materials.map((m): ItemStock => {
      const o = outstanding.get(m.id);
      return {
        itemId: m.id,
        kind: "RAW_MATERIAL",
        sku: m.sku,
        description: m.description,
        uom: m.uom,
        ...stockOf(m.id, "RAW_MATERIAL"),
        openPurchaseOrderQuantity: o?.qty ?? 0,
        earliestPromisedMs: o?.earliest ?? null,
        short: (shortCount.get(m.id) ?? 0) > 0,
        blockedOrders: shortCount.get(m.id) ?? 0,
      };
    }),
    ...master.products.map((p): ItemStock => ({
      itemId: p.id,
      kind: "FINISHED_GOOD",
      sku: p.sku,
      description: p.name,
      uom: "EA",
      ...stockOf(p.id, "FINISHED_GOOD"),
      openPurchaseOrderQuantity: null,
      earliestPromisedMs: null,
      short: false,
      blockedOrders: 0,
    })),
  ];
  return { asOfMs, locations, items };
}
