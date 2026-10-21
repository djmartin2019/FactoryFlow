import * as THREE from "three";

import type { FactoryObjectConfig, FactoryObjectType } from "./FactoryObject";
import { makeNonInteractive } from "./geometryUtils";
import { LABEL_LAYER } from "./RenderPipeline";

/**
 * Floating station labels are canvas-texture sprites rather than
 * CSS2DRenderer elements. Tradeoff: sprites live in the same WebGL pass (no
 * second DOM layer to keep in sync, no layout thrash, trivially excluded
 * from raycasting) and always face the camera, at the cost of fixed texture
 * resolution and no CSS styling. For ~11 short, static labels that is the
 * lighter option and needs no extra dependency.
 */

const TYPE_LABELS: Record<FactoryObjectType, string> = {
  pallet: "Pallet staging",
  rack: "Storage rack",
  workstation: "Assembly bench",
  inspection: "Inspection table",
  shipping: "Shipping staging",
};

const CANVAS_W = 400;
const CANVAS_H = 150;

/** On-screen label height in CSS pixels; width follows the canvas aspect. */
const SCREEN_HEIGHT_PX = 38;
const MAX_WORLD_HEIGHT = 4;
/** Gap between the top of the equipment and the bottom of the label. */
const LABEL_CLEARANCE = 0.3;

export class StationLabel {
  public readonly sprite: THREE.Sprite;

  private readonly worldPosition = new THREE.Vector3();

  /**
   * @param lift extra height (m) so labels of stations stacked in z do not
   *   cover one another on screen.
   */
  constructor(config: FactoryObjectConfig, accent: number, lift = 0) {
    const texture = new THREE.CanvasTexture(drawLabel(config, accent));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        // Labels stay readable when equipment is between them and the camera.
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    // Anchor the bottom-centre so the label sits above the station.
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 20;
    // Drawn in a separate pass after post-processing (see RenderPipeline).
    this.sprite.layers.set(LABEL_LAYER);
    this.sprite.name = `${config.id}-label`;

    // Positioned from the station's own envelope, not global coordinates.
    this.sprite.position.set(
      config.position[0],
      config.size[1] + LABEL_CLEARANCE + lift,
      config.position[2],
    );

    makeNonInteractive(this.sprite);
  }

  /**
   * Keeps the label at a roughly constant on-screen size as the camera
   * dollies, so it stays legible zoomed out and does not swallow the
   * scene zoomed in. Sprites already billboard towards the camera.
   */
  public update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    this.sprite.getWorldPosition(this.worldPosition);
    const distance = camera.position.distanceTo(this.worldPosition);
    const worldPerPixel =
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
      Math.max(viewportHeightPx, 1);

    const height = Math.min(SCREEN_HEIGHT_PX * worldPerPixel, MAX_WORLD_HEIGHT);
    this.sprite.scale.set(height * (CANVAS_W / CANVAS_H), height, 1);
  }
}

function drawLabel(config: FactoryObjectConfig, accent: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const accentCss = `#${accent.toString(16).padStart(6, "0")}`;

  // Panel with a department-coloured accent bar.
  ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
  ctx.beginPath();
  ctx.roundRect(4, 4, CANVAS_W - 8, CANVAS_H - 8, 16);
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = accentCss;
  ctx.beginPath();
  ctx.roundRect(4, 4, 18, CANVAS_H - 8, [18, 0, 0, 18]);
  ctx.fill();

  const left = 38;
  const maxWidth = CANVAS_W - left - 24;
  ctx.textBaseline = "alphabetic";

  const name = config.name ?? config.id;
  ctx.fillStyle = "#f8fafc";
  ctx.font = fitFont(ctx, name, "700", 46, maxWidth, "system-ui, sans-serif");
  ctx.fillText(name, left, 68);

  ctx.fillStyle = "#cbd5e1";
  const detail = `${config.id}  ·  ${TYPE_LABELS[config.type]}`;
  ctx.font = fitFont(ctx, detail, "500", 30, maxWidth, "ui-monospace, Menlo, monospace");
  ctx.fillText(detail, left, 118);

  return canvas;
}

/** Largest font size <= `size` at which `text` fits within `maxWidth`. */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: string,
  size: number,
  maxWidth: number,
  family: string,
): string {
  let px = size;
  ctx.font = `${weight} ${px}px ${family}`;
  while (px > 18 && ctx.measureText(text).width > maxWidth) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return ctx.font;
}
