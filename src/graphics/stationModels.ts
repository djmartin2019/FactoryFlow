import type { FactoryObjectConfig } from "./FactoryObject";

/** Which shared material a part uses; "status" is recoloured by the simulation. */
export type PartMaterial =
  "status" | "wood" | "carton" | "steel" | "dark" | "light";

export interface StationPart {
  material: PartMaterial;
  size: [number, number, number];
  /** Centre, relative to the station's floor-footprint centre (y = 0 is floor). */
  pos: [number, number, number];
}

type PartList = StationPart[];

const add = (
  parts: PartList,
  material: PartMaterial,
  size: [number, number, number],
  pos: [number, number, number],
): void => {
  parts.push({ material, size, pos });
};

/** Wooden pallet deck, 1.2 x 1.0 m, sitting on `baseY`. */
function pallet(parts: PartList, x: number, baseY: number, z: number): void {
  add(parts, "wood", [1.2, 0.14, 1.0], [x, baseY + 0.07, z]);
}

/** Receiving / shipping: a status-coloured pad with palletised stock. */
function stagingPad(config: FactoryObjectConfig, shipping: boolean): PartList {
  const [w, , d] = config.size;
  const parts: PartList = [];
  const padTop = 0.12;
  // The pad is the status-coloured part and extends past the pallets.
  add(parts, "status", [w, padTop, d], [0, padTop / 2, 0]);

  if (!shipping) {
    // 3 x 2 grid of 1.2 x 1.0 m pallets; a couple are empty/partly loaded.
    const loads = [0.9, 1.2, 0.6, 1.0, 0.0, 0.8];
    let i = 0;
    for (const row of [-0.6, 0.6]) {
      for (const col of [-1.4, 0, 1.4]) {
        const load = loads[i++]!;
        pallet(parts, col, padTop, row);
        if (load > 0) {
          const h = load;
          add(parts, "carton", [1.1, h, 0.9], [col, padTop + 0.14 + h / 2, row]);
        }
      }
    }
  } else {
    // Wrapped outbound pallets plus a packing bench at the front edge.
    for (const col of [-1.5, 0, 1.5]) {
      pallet(parts, col, padTop, -0.55);
      add(parts, "light", [1.1, 1.1, 0.9], [col, padTop + 0.14 + 0.55, -0.55]);
    }
    add(parts, "steel", [2.0, 0.85, 0.6], [0, padTop + 0.425, 0.95]);
    add(parts, "dark", [0.5, 0.05, 0.3], [0.5, padTop + 0.875, 0.95]);
  }
  return parts;
}

/** Inventory: a three-level pallet rack; uprights and beams are status-coloured. */
function rack(config: FactoryObjectConfig): PartList {
  const [w, h, d] = config.size;
  const parts: PartList = [];
  const bays = 3;
  const levels = [0.25, 1.25, 2.25];

  for (let i = 0; i <= bays; i++) {
    const x = -w / 2 + 0.05 + (i * (w - 0.1)) / bays;
    add(parts, "status", [0.1, h, d], [x, h / 2, 0]);
  }
  for (const y of levels) {
    for (const side of [-1, 1]) {
      add(parts, "status", [w, 0.12, 0.08], [0, y, side * (d / 2 - 0.04)]);
    }
    add(parts, "steel", [w - 0.1, 0.03, d - 0.12], [0, y + 0.075, 0]);
  }
  // Loaded pallet positions; a few bays are deliberately empty.
  const bayW = (w - 0.1) / bays;
  levels.forEach((y, level) => {
    for (let bay = 0; bay < bays; bay++) {
      if ((level + bay) % 4 === 3) continue;
      const x = -w / 2 + 0.05 + bayW * (bay + 0.5);
      add(parts, "carton", [bayW - 0.35, 0.8, d - 0.25], [x, y + 0.09 + 0.4, 0]);
    }
  });
  return parts;
}

/** Assembly: a workbench with a top, lower shelf, riser frame and light bar. */
function workbench(config: FactoryObjectConfig): PartList {
  const [w, h, d] = config.size;
  const parts: PartList = [];
  const topY = 0.9;
  add(parts, "status", [w, 0.12, d], [0, topY, 0]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(parts, "steel", [0.1, topY - 0.06, 0.1],
        [sx * (w / 2 - 0.15), (topY - 0.06) / 2, sz * (d / 2 - 0.15)]);
    }
  }
  add(parts, "steel", [w - 0.4, 0.05, d - 0.4], [0, 0.3, 0]);
  // Back riser with a light bar, as on a typical electrical assembly bench.
  for (const sx of [-1, 1]) {
    add(parts, "steel", [0.08, h - topY, 0.08],
      [sx * (w / 2 - 0.2), topY + (h - topY) / 2, -d / 2 + 0.15]);
  }
  add(parts, "light", [w - 0.5, 0.06, 0.25], [0, h - 0.03, -d / 2 + 0.25]);
  // Work in progress: enclosure shells, a harness reel and a monitor.
  add(parts, "steel", [0.9, 0.6, 0.25], [-1.2, topY + 0.36, 0.1]);
  add(parts, "steel", [0.7, 0.45, 0.25], [-0.1, topY + 0.285, 0.1]);
  add(parts, "dark", [0.5, 0.35, 0.05], [1.2, topY + 0.5, -0.2]);
  add(parts, "carton", [0.5, 0.25, 0.4], [1.3, topY + 0.19, 0.4]);
  return parts;
}

/** Quality control: an inspection table under a lamp hood with a test fixture. */
function inspectionTable(config: FactoryObjectConfig): PartList {
  const [w, h, d] = config.size;
  const parts: PartList = [];
  const topY = 0.9;
  add(parts, "status", [w, 0.12, d], [0, topY, 0]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(parts, "steel", [0.1, topY - 0.06, 0.1],
        [sx * (w / 2 - 0.15), (topY - 0.06) / 2, sz * (d / 2 - 0.15)]);
    }
  }
  // Lamp hood on two posts: reads as an inspection / test station.
  for (const sx of [-1, 1]) {
    add(parts, "steel", [0.08, h - topY, 0.08],
      [sx * (w / 2 - 0.25), topY + (h - topY) / 2, -d / 2 + 0.2]);
  }
  add(parts, "light", [w - 0.4, 0.14, 0.9], [0, h - 0.07, -d / 2 + 0.45]);
  add(parts, "dark", [1.0, 0.4, 0.7], [-0.7, topY + 0.26, 0.1]);
  add(parts, "dark", [0.55, 0.36, 0.05], [0.9, topY + 0.24, -0.2]);
  add(parts, "steel", [0.5, 0.15, 0.4], [0.9, topY + 0.135, 0.3]);
  return parts;
}

/**
 * Builds the primitive-box parts for a station. Parts are expressed
 * relative to the station's floor-footprint centre; config.size is the
 * overall envelope the parts must stay within.
 */
export function buildStationParts(config: FactoryObjectConfig): PartList {
  switch (config.type) {
    case "pallet": return stagingPad(config, false);
    case "shipping": return stagingPad(config, true);
    case "rack": return rack(config);
    case "workstation": return workbench(config);
    case "inspection": return inspectionTable(config);
  }
}
