/**
 * Replay engine – the integration point for a future simulation clock.
 * Pure TypeScript: no timers, no DOM, no Three.js.
 *
 *   const replay = new FactoryReplay(initialStateFile, events);
 *   replay.onEvent((e, state) => animate(e));
 *   // each frame: simulatedNow += dt * speed
 *   replay.advanceTo(new Date(simulatedNow).toISOString());
 */
import { applyEventInPlace } from "./state.ts";
import type { FactoryEvent, FactoryState, InitialStateFile, IsoTimestamp, MasterData } from "./types.ts";

export type ReplayListener = (event: FactoryEvent, state: Readonly<FactoryState>) => void;

export function replayEvents(master: MasterData, initial: FactoryState, events: FactoryEvent[]): FactoryState {
  const state = structuredClone(initial);
  for (const event of events) applyEventInPlace(state, event, master);
  return state;
}

export class FactoryReplay {
  readonly master: MasterData;
  private readonly initial: FactoryState;
  private readonly events: FactoryEvent[];
  /** Event timestamps in epoch ms, parsed once. */
  private readonly eventTimesMs: number[];
  private current: FactoryState;
  private cursor = 0;
  private listeners: ReplayListener[] = [];

  constructor(initial: InitialStateFile, events: FactoryEvent[]) {
    this.master = initial.master;
    this.initial = initial.state;
    this.events = events;
    this.eventTimesMs = events.map((e) => Date.parse(e.timestamp));
    this.current = structuredClone(initial.state);
  }

  /** Live state (mutated as the replay advances). Treat as read-only. */
  get state(): Readonly<FactoryState> {
    return this.current;
  }

  get position(): number {
    return this.cursor;
  }

  get done(): boolean {
    return this.cursor >= this.events.length;
  }

  get nextEventTime(): IsoTimestamp | undefined {
    return this.events[this.cursor]?.timestamp;
  }

  onEvent(listener: ReplayListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Apply the next event, notify listeners, return it. */
  step(): FactoryEvent | undefined {
    const event = this.events[this.cursor];
    if (!event) return undefined;
    applyEventInPlace(this.current, event, this.master);
    this.cursor++;
    for (const l of this.listeners) l(event, this.current);
    return event;
  }

  /** Apply every event with timestamp <= `time`. */
  advanceTo(time: IsoTimestamp): FactoryEvent[] {
    return this.advanceToMs(Date.parse(time));
  }

  /** Same as `advanceTo`, taking epoch ms (no string parsing on the hot path). */
  advanceToMs(limitMs: number): FactoryEvent[] {
    const applied: FactoryEvent[] = [];
    while (this.cursor < this.events.length && this.eventTimesMs[this.cursor] <= limitMs) {
      applied.push(this.step()!);
    }
    return applied;
  }

  /** Jump to `time` without notifying listeners (scrubbing). */
  seekTo(time: IsoTimestamp): void {
    const saved = this.listeners;
    this.listeners = [];
    if (Date.parse(time) < Date.parse(this.current.asOf)) this.reset();
    this.advanceTo(time);
    this.listeners = saved;
  }

  reset(): void {
    this.current = structuredClone(this.initial);
    this.cursor = 0;
  }

  snapshot(): FactoryState {
    return structuredClone(this.current);
  }
}
