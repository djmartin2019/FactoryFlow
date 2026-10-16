/**
 * Bill of materials read model: per product, its components with quantities,
 * standard costs and sourcing. Master data only, so it is independent of
 * simulation time and of where the master data came from.
 */
import type { Cents, Id, MasterData } from "../manufacturing/types.ts";

export interface BomLineView {
  materialId: Id;
  sku: string;
  description: string;
  uom: string;
  quantityPer: number;
  unitCostCents: Cents;
  /** quantityPer x unitCostCents. */
  extendedCostCents: Cents;
  supplierName: string;
  leadTimeDays: number;
}

export interface BomView {
  productId: Id;
  sku: string;
  name: string;
  bomId: Id;
  version: string;
  lines: BomLineView[];
  /** Σ line extended cost; equals the product's standard cost by construction. */
  totalCostCents: Cents;
  listPriceCents: Cents;
  /** Longest supplier lead time among components, days. */
  longestLeadTimeDays: number;
}

export function billsOfMaterials(master: MasterData): BomView[] {
  return master.products.map((product) => {
    const bom = master.billsOfMaterials.find((b) => b.productId === product.id);
    const lines: BomLineView[] = (bom?.lines ?? []).map((line) => {
      const material = master.materials.find((m) => m.id === line.materialId);
      const unitCostCents = material?.standardCostCents ?? 0;
      return {
        materialId: line.materialId,
        sku: material?.sku ?? line.materialId,
        description: material?.description ?? line.materialId,
        uom: material?.uom ?? "EA",
        quantityPer: line.quantityPer,
        unitCostCents,
        extendedCostCents: unitCostCents * line.quantityPer,
        supplierName: master.suppliers.find((s) => s.id === material?.supplierId)?.name ?? material?.supplierId ?? "N/A",
        leadTimeDays: material?.leadTimeDays ?? 0,
      };
    });
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      bomId: bom?.id ?? product.bomId,
      version: bom?.version ?? "N/A",
      lines,
      totalCostCents: lines.reduce((sum, l) => sum + l.extendedCostCents, 0),
      listPriceCents: product.listPriceCents,
      longestLeadTimeDays: lines.reduce((max, l) => Math.max(max, l.leadTimeDays), 0),
    };
  });
}
