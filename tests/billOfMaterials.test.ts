import { describe, expect, it } from "vitest";
import { billsOfMaterials } from "../src/analytics/index.ts";
import { buildMasterData, resolveConfig } from "../src/manufacturing/masterData.ts";
import { fmtMoney } from "../src/ui/explorer/format.ts";

const master = buildMasterData(resolveConfig({}));

describe("bill of materials view", () => {
  const boms = billsOfMaterials(master);

  it("has one BOM per product with every line resolved to a material", () => {
    expect(boms.map((b) => b.productId)).toEqual(master.products.map((p) => p.id));
    for (const b of boms) {
      expect(b.lines.length).toBeGreaterThan(0);
      for (const l of b.lines) {
        expect(master.materials.some((m) => m.id === l.materialId), `${b.sku} ${l.materialId}`).toBe(true);
        expect(l.extendedCostCents).toBe(l.unitCostCents * l.quantityPer);
      }
    }
  });

  it("totals to each product's standard cost", () => {
    for (const b of boms) {
      const product = master.products.find((p) => p.id === b.productId)!;
      expect(b.totalCostCents, b.sku).toBe(product.standardCostCents);
    }
  });

  it("formats integer cents as dollars", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(5)).toBe("$0.05");
    expect(fmtMoney(123456)).toBe("$1,234.56");
    expect(fmtMoney(-250)).toBe("-$2.50");
  });
});
