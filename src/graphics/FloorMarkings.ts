import * as THREE from "three";

import type { FloorMarkingsConfig, Heading } from "../data/layoutTypes";
import {
  decalMaterial,
  flatRect,
  makeNonInteractive,
  mergeAll,
  outlineRects,
} from "./geometryUtils";

const FILL_Y = 0.03;
const LINE_Y = 0.04;
const ARROW_Y = 0.045;

const LINE_THICKNESS = 0.12;

/** Rotation about +y that turns a +x-pointing shape to each heading. */
const HEADING_ANGLE: Record<Heading, number> = {
  E: 0,
  N: Math.PI / 2,
  W: Math.PI,
  S: -Math.PI / 2,
};

/**
 * Aisle edge lines, pedestrian walkways and material-flow arrows. Each
 * category is merged into a single mesh (4 draw calls total).
 */
export class FloorMarkings {
  public readonly group = new THREE.Group();

  constructor(config: FloorMarkingsConfig) {
    this.group.name = "floor-markings";

    const aisleLines = config.aisles.flatMap((r) => outlineRects(r, LINE_THICKNESS));
    const walkwayLines = config.walkways.flatMap((r) => outlineRects(r, LINE_THICKNESS * 0.75));

    this.addMerged(
      aisleLines.map((r) => flatRect(r, LINE_Y)),
      decalMaterial({ color: 0xd4a72c, transparent: true, opacity: 0.85 }, 4),
    );
    this.addMerged(
      config.walkways.map((r) => flatRect(r, FILL_Y)),
      decalMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.12 }, 4),
    );
    this.addMerged(
      walkwayLines.map((r) => flatRect(r, LINE_Y)),
      decalMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.7 }, 5),
    );
    this.addMerged(
      config.arrows.map((a) => arrowGeometry(a.x, a.z, a.heading)),
      decalMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.8 }, 6),
    );

    makeNonInteractive(this.group);
  }

  private addMerged(geometries: THREE.BufferGeometry[], material: THREE.Material): void {
    if (geometries.length === 0) return;
    const mesh = new THREE.Mesh(mergeAll(geometries), material);
    mesh.renderOrder = 4;
    this.group.add(mesh);
  }
}

/** A flat arrow (shaft + head), 2.4 m long, centred at (x, z). */
function arrowGeometry(x: number, z: number, heading: Heading): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-1.2, -0.18);
  shape.lineTo(0.2, -0.18);
  shape.lineTo(0.2, -0.55);
  shape.lineTo(1.2, 0);
  shape.lineTo(0.2, 0.55);
  shape.lineTo(0.2, 0.18);
  shape.lineTo(-1.2, 0.18);
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape).toNonIndexed();
  geometry.rotateX(-Math.PI / 2); // shape (x, y) -> floor (x, -z), normal up
  geometry.rotateY(HEADING_ANGLE[heading]);
  geometry.translate(x, ARROW_Y, z);
  return geometry;
}
