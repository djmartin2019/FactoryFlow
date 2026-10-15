import { FactoryReplay } from "../manufacturing/replay";

import type {
  FactoryEvent,
  FactoryState,
  InitialStateFile,
} from "../manufacturing/types";

export class SimulationController {
  private readonly replay: FactoryReplay;

  private currentTimeMs: number;
  private playing = false;
  private speed = 60;
  private readonly startMs: number;
  private readonly endMs: number;
  private resetEpoch = 0;
  private seekMs: number | null = null;

  constructor(initialState: InitialStateFile, events: FactoryEvent[]) {
    this.replay = new FactoryReplay(initialState, events);

    this.currentTimeMs = Date.parse(initialState.state.asOf);
    this.startMs = this.currentTimeMs;
    this.endMs = events.length ? Date.parse(events[events.length - 1].timestamp) : this.startMs;
  }

  public play(): void {
    if (!this.replay.done) {
      this.playing = true;
    }
  }

  public pause(): void {
    this.playing = false;
  }

  public setSpeed(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error("Speed must be positive");
    }

    this.speed = multiplier;
  }

  public update(deltaSeconds: number): void {
    if (!this.playing) return;

    this.currentTimeMs += deltaSeconds * 1000 * this.speed;

    this.replay.advanceToMs(this.currentTimeMs);

    if (this.replay.done) {
      this.pause();
    }
  }

  public reset(): void {
    this.pause();
    this.replay.reset();

    this.currentTimeMs = Date.parse(this.replay.state.asOf);
    this.resetEpoch++;
  }

  /** Jump the one simulation clock to `timeMs` (clamped to the dataset). */
  public seekTo(timeMs: number): void {
    const target = Math.min(this.endMs, Math.max(this.startMs, timeMs));

    const t0 = performance.now();
    this.replay.seekTo(new Date(target).toISOString());
    this.seekMs = performance.now() - t0;
    this.currentTimeMs = target;
    this.resetEpoch++;

    if (this.replay.done) this.pause();
  }

  /** Increments whenever history was discarded (reset/seek); consumers drop cached events. */
  public get epoch(): number {
    return this.resetEpoch;
  }

  /** Duration of the most recent seek (ms), for the optional perf overlay. */
  public get lastSeekMs(): number | null {
    return this.seekMs;
  }

  /** Number of events applied so far. */
  public get eventsApplied(): number {
    return this.replay.position;
  }

  public get speedMultiplier(): number {
    return this.speed;
  }

  public get startTime(): Date {
    return new Date(this.startMs);
  }

  public get endTime(): Date {
    return new Date(this.endMs);
  }

  /** 0..1 position of the simulated clock within the generated dataset. */
  public get progress(): number {
    const span = this.endMs - this.startMs;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (this.currentTimeMs - this.startMs) / span));
  }

  public get isDone(): boolean {
    return this.replay.done;
  }

  public get state(): Readonly<FactoryState> {
    return this.replay.state;
  }

  public get currentTime(): Date {
    return new Date(this.currentTimeMs);
  }

  public get isPlaying(): boolean {
    return this.playing;
  }

  public get engine(): FactoryReplay {
    return this.replay;
  }
}
