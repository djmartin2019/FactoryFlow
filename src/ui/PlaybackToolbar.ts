import type { SimulationController } from "../simulation/SimulationController";
import { el, formatSimTime, setText } from "./dom";

const SPEEDS = [60, 600, 3600, 86400] as const;

export class PlaybackToolbar {
  readonly element = el("div", "toolbar");
  private readonly playButton = el("button", "btn primary", "Play");
  private readonly clock = el("div", "clock", "");
  private readonly progress = el("input", "progress");
  private readonly speedButtons = new Map<number, HTMLButtonElement>();

  private readonly simulation: SimulationController;

  constructor(simulation: SimulationController, onChange: () => void) {
    this.simulation = simulation;
    this.playButton.addEventListener("click", () => {
      if (simulation.isPlaying) {
        simulation.pause();
      } else {
        if (simulation.isDone) simulation.reset();
        simulation.play();
      }
      onChange();
    });

    const reset = el("button", "btn", "Reset");
    reset.addEventListener("click", () => {
      simulation.reset();
      onChange();
    });

    const speeds = el("div", "speeds");
    for (const s of SPEEDS) {
      const b = el("button", "btn speed", `${s}×`);
      b.addEventListener("click", () => {
        simulation.setSpeed(s);
        onChange();
      });
      this.speedButtons.set(s, b);
      speeds.appendChild(b);
    }

    this.progress.type = "range";
    this.progress.min = "0";
    this.progress.max = "1000";
    this.progress.step = "1";
    this.progress.setAttribute("aria-label", "Simulation progress");
    this.progress.addEventListener("input", () => {
      const start = simulation.startTime.getTime();
      const end = simulation.endTime.getTime();
      simulation.seekTo(start + (Number(this.progress.value) / 1000) * (end - start));
      onChange();
    });

    this.element.append(this.playButton, reset, speeds, this.clock, this.progress);
  }

  update(): void {
    const sim = this.simulation;
    setText(this.playButton, sim.isPlaying ? "Pause" : sim.isDone ? "Replay" : "Play");
    setText(this.clock, formatSimTime(sim.currentTime));
    for (const [s, b] of this.speedButtons) b.classList.toggle("active", s === sim.speedMultiplier);
    // Don't fight the user while they drag the slider.
    if (document.activeElement !== this.progress) this.progress.value = String(Math.round(sim.progress * 1000));
  }
}
