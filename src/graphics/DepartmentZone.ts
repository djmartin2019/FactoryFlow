import * as THREE from "three";

import type { DepartmentConfig } from "../data/layoutTypes";
import {
  decalMaterial,
  flatRect,
  makeNonInteractive,
  mergeAll,
  outlineRects,
} from "./geometryUtils";

// Heights above the floor (y = 0). The floor grid sits at 0.01; decals are
// stacked above it and additionally get polygonOffset (see decalMaterial).
const OVERLAY_Y = 0.02;
const BORDER_Y = 0.035;
const TEXT_Y = 0.05;

const BORDER_THICKNESS = 0.15;
const CORNER_THICKNESS = 0.35;
const CORNER_LENGTH = 1.4;

/**
 * A department's floor footprint: translucent tint, boundary line with
 * heavier corner brackets, and a floor-painted name. Purely decorative: every
 * mesh has raycasting disabled and the zone is never registered as selectable.
 */
export class DepartmentZone {
  public readonly group = new THREE.Group();

  public readonly config: DepartmentConfig;

  constructor(config: DepartmentConfig) {
    this.config = config;
    const { bounds, color } = config;
    this.group.name = `zone-${config.id}`;

    // Tint: low opacity so it reads as floor paint and stays clearly
    // different from the saturated equipment status colours.
    const overlay = new THREE.Mesh(
      flatRect(bounds, OVERLAY_Y),
      decalMaterial({ color, transparent: true, opacity: 0.16 }, 1),
    );
    overlay.renderOrder = 1;

    const lines = [
      ...outlineRects(bounds, BORDER_THICKNESS),
      ...cornerBrackets(bounds),
    ].map((rect) => flatRect(rect, BORDER_Y));
    const border = new THREE.Mesh(
      mergeAll(lines),
      decalMaterial({ color, transparent: true, opacity: 0.75 }, 2),
    );
    border.renderOrder = 2;

    this.group.add(overlay, border, createFloorName(config));
    makeNonInteractive(this.group);
  }
}

/** Short L-shaped brackets at the four corners, drawn as two bars each. */
function cornerBrackets(b: DepartmentConfig["bounds"]) {
  const t = CORNER_THICKNESS;
  const l = CORNER_LENGTH;
  return [
    { minX: b.minX, maxX: b.minX + l, minZ: b.minZ, maxZ: b.minZ + t },
    { minX: b.minX, maxX: b.minX + t, minZ: b.minZ, maxZ: b.minZ + l },
    { minX: b.maxX - l, maxX: b.maxX, minZ: b.minZ, maxZ: b.minZ + t },
    { minX: b.maxX - t, maxX: b.maxX, minZ: b.minZ, maxZ: b.minZ + l },
    { minX: b.minX, maxX: b.minX + l, minZ: b.maxZ - t, maxZ: b.maxZ },
    { minX: b.minX, maxX: b.minX + t, minZ: b.maxZ - l, maxZ: b.maxZ },
    { minX: b.maxX - l, maxX: b.maxX, minZ: b.maxZ - t, maxZ: b.maxZ },
    { minX: b.maxX - t, maxX: b.maxX, minZ: b.maxZ - l, maxZ: b.maxZ },
  ];
}

/**
 * Department name painted on the floor along the zone's south edge (the
 * edge nearest the default camera) so it reads upright from there.
 */
function createFloorName(config: DepartmentConfig): THREE.Mesh {
  const { bounds, color } = config;
  const text = config.name.toUpperCase();

  const fontPx = 64;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const family = "700 " + fontPx + "px system-ui, sans-serif";
  let textWidth = 400;
  if (ctx) {
    ctx.font = family;
    textWidth = ctx.measureText(text).width;
  }
  canvas.width = Math.ceil(textWidth + 48);
  canvas.height = 96;
  const draw = canvas.getContext("2d");
  if (draw) {
    draw.font = family;
    draw.textBaseline = "middle";
    draw.textAlign = "center";
    draw.fillStyle = "#" + new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55).getHexString();
    draw.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  // 1.1 m tall letters, shrunk if the name would not fit the zone.
  const zoneWidth = bounds.maxX - bounds.minX - 2;
  let height = 1.1;
  let width = (canvas.width / canvas.height) * height;
  if (width > zoneWidth) {
    width = zoneWidth;
    height = width / (canvas.width / canvas.height);
  }

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    decalMaterial({ map: texture, transparent: true, toneMapped: false }, 3),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((bounds.minX + bounds.maxX) / 2, TEXT_Y, bounds.maxZ - 1.0);
  mesh.renderOrder = 3;
  return mesh;
}
