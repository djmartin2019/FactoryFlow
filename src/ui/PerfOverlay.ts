import { el } from "./dom";

export interface PerfSample {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  drawCalls: number;
  triangles: number;
  meshes: number;
  eventsPerSec: number;
  totalEvents: number;
  lastSeekMs: number | null;
  /** 3D render quality tier in use (it can step down automatically). */
  quality: string;
}

/** Re-derive the DOM at this interval; per-frame work is just a few additions. */
const WINDOW_MS = 500;

/**
 * Optional performance HUD. Off unless the page is opened with `?perf` (or
 * toggled with the P key). When disabled, `frame()` is never called and
 * nothing is measured, so the normal render path pays only one boolean check.
 *
 * Per frame it only accumulates dt and reads counters the renderer already
 * keeps (`renderer.info`); the DOM is touched twice a second.
 */
export class PerfOverlay {
  readonly element = el("div", "perf-overlay");
  /** Latest finished window; also exposed as `window.__ffPerf` for benchmarking. */
  latest: PerfSample | null = null;

  private readonly body = el("pre", "perf-body", "measuring...");
  private enabled: boolean;
  private frames = 0;
  private elapsedMs = 0;
  private worstMs = 0;
  private windowStartEvents = 0;
  private windowEpoch = 0;
  private countedEvents = 0;

  static requested(): boolean {
    try {
      return new URLSearchParams(window.location.search).has("perf");
    } catch {
      return false;
    }
  }

  private readonly readMeshCount: () => number;

  constructor(parent: HTMLElement, readMeshCount: () => number) {
    this.readMeshCount = readMeshCount;
    this.enabled = PerfOverlay.requested();
    this.element.append(this.body);
    this.element.hidden = !this.enabled;
    parent.appendChild(this.element);
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== "p" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      this.setEnabled(!this.enabled);
    });
    (window as unknown as { __ffPerf?: () => PerfSample | null }).__ffPerf = () => this.latest;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.element.hidden = !on;
    this.reset(0, 0);
  }

  private reset(cursor: number, epoch: number): void {
    this.frames = 0;
    this.elapsedMs = 0;
    this.worstMs = 0;
    this.windowStartEvents = cursor;
    this.windowEpoch = epoch;
  }

  /**
   * Call once per rendered frame (after render) while enabled.
   * `eventCursor` is the number of events applied so far; `epoch` changes on
   * reset/seek so jumps are not reported as processing throughput.
   */
  frame(
    dtMs: number,
    drawCalls: number,
    triangles: number,
    eventCursor: number,
    epoch: number,
    lastSeekMs: number | null,
    quality = "",
  ): void {
    if (epoch !== this.windowEpoch || eventCursor < this.windowStartEvents) {
      this.reset(eventCursor, epoch);
    }
    this.frames++;
    this.elapsedMs += dtMs;
    if (dtMs > this.worstMs) this.worstMs = dtMs;
    if (this.elapsedMs < WINDOW_MS) return;

    const seconds = this.elapsedMs / 1000;
    this.countedEvents = eventCursor - this.windowStartEvents;
    const sample: PerfSample = {
      fps: this.frames / seconds,
      frameMs: this.elapsedMs / this.frames,
      worstFrameMs: this.worstMs,
      drawCalls,
      triangles,
      meshes: this.readMeshCount(),
      eventsPerSec: this.countedEvents / seconds,
      totalEvents: eventCursor,
      lastSeekMs,
      quality,
    };
    this.latest = sample;
    this.body.textContent = format(sample);
    this.reset(eventCursor, epoch);
  }
}

function format(s: PerfSample): string {
  return [
    `FPS          ${s.fps.toFixed(0)}`,
    `Frame        ${s.frameMs.toFixed(1)} ms (worst ${s.worstFrameMs.toFixed(1)})`,
    `Draw calls   ${s.drawCalls}`,
    `Triangles    ${s.triangles.toLocaleString("en-US")}`,
    `Meshes       ${s.meshes}`,
    `Events/s     ${s.eventsPerSec.toFixed(0)}  (total ${s.totalEvents})`,
    `Last seek    ${s.lastSeekMs === null ? "-" : s.lastSeekMs.toFixed(1) + " ms"}`,
    `Quality      ${s.quality || "-"}`,
  ].join("\n");
}
