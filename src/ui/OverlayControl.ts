import { OVERLAY_LABELS, OVERLAY_MODES, type Overlay, type OverlayMode } from "../analytics/overlays";
import { el } from "./dom";

/**
 * "Colour the factory by" selector shown over the 3D view. Status is the default; the other modes recolour stations and racks from the
 * same measures the Explorer tabs use. The caption always says what the colours mean, because a colour with no key is not an analysis.
 */
export class OverlayControl {
  readonly element = el("div", "overlay-control");
  private readonly buttons = new Map<OverlayMode, HTMLButtonElement>();
  private readonly title = el("div", "overlay-title");
  private readonly legend = el("div", "overlay-legend");

  constructor(container: HTMLElement, onChange: (mode: OverlayMode) => void) {
    const row = el("div", "overlay-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Colour the factory by");
    row.append(el("span", "overlay-label", "Colour by"));
    for (const mode of OVERLAY_MODES) {
      const b = el("button", "overlay-btn", OVERLAY_LABELS[mode]);
      b.addEventListener("click", () => onChange(mode));
      this.buttons.set(mode, b);
      row.append(b);
    }
    this.element.append(row, this.title, this.legend);
    container.appendChild(this.element);
    this.setMode("status", null);
  }

  /** Reflect the active mode and describe its colours. */
  setMode(mode: OverlayMode, overlay: Overlay | null): void {
    for (const [m, b] of this.buttons) {
      b.classList.toggle("active", m === mode);
      b.setAttribute("aria-pressed", String(m === mode));
    }
    if (!overlay) {
      this.title.textContent = "Station status: running, idle, blocked on material, or down.";
      this.legend.textContent = "";
      this.legend.hidden = true;
      return;
    }
    this.title.textContent = overlay.title;
    this.legend.hidden = false;
    this.legend.textContent =
      overlay.cells.length === 0
        ? `Nothing to highlight at this simulated time (${overlay.legend.muted}).`
        : `Light blue = ${overlay.legend.low} → bright = ${overlay.legend.high}. Dark = ${overlay.legend.muted}. Highlighted objects have outlined labels; other labels are faded.`;
  }
}
