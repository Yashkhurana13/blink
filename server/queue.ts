export type Rejection = { error: 'rate_limited' | 'busy'; retryAfterSec: number };
export type Job = {
  ready: Promise<void>;
  onPosition(listener: (position: number) => void): void;
  release(): void;
};
type Entry = { client: string; slots: number; start: () => void; position: number; listener?: (n: number) => void };
type Charge = { at: number; count: number };
type Race = { key: string; lane: 'cerebras' | 'compare' };
type ClientRun = { raceKey?: string; lanes: Set<string>; jobs: number };
const HOUR = 3_600_000;

export class RollingLimit {
  private charges = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}

  retryAfter(key: string) {
    const now = Date.now();
    for (const [client, charges] of this.charges) {
      const recent = charges.filter(at => now - at < this.windowMs);
      if (recent.length) this.charges.set(client, recent);
      else this.charges.delete(client);
    }
    const charges = this.charges.get(key) ?? [];
    return charges.length >= this.limit ? Math.max(1, Math.ceil((charges[0] + this.windowMs - now) / 1000)) : 0;
  }

  record(key: string) {
    const charges = this.charges.get(key) ?? [];
    charges.push(Date.now());
    this.charges.set(key, charges);
  }
}

export function positiveInteger(value: string | undefined, fallback: number, minimum = 1) {
  const n = Number(value);
  return value !== undefined && Number.isSafeInteger(n) && n >= minimum ? n : fallback;
}

export class Scheduler {
  private used = 0;
  private waiting: Entry[] = [];
  private clients = new Map<string, ClientRun>();
  private charges = new Map<string, Charge[]>();
  private maxConcurrent: number;
  private maxQueue: number;
  private hourlyLimit: number;
  private globalJobs: RollingLimit;

  constructor(options: { maxConcurrent?: number; maxQueue?: number; hourlyLimit?: number; globalJobsPerMin?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 8;
    this.maxQueue = options.maxQueue ?? 40;
    this.hourlyLimit = options.hourlyLimit ?? 30;
    this.globalJobs = new RollingLimit(options.globalJobsPerMin ?? 40, 60_000);
  }

  reserve(client: string, slots: number, race?: Race): Job | Rejection {
    const now = Date.now();
    for (const [key, charges] of this.charges) {
      const recent = charges.filter(c => now - c.at < HOUR);
      if (recent.length) this.charges.set(key, recent);
      else this.charges.delete(key);
    }
    const run = this.clients.get(client);
    // The v1 race uses two HTTP requests for one run. Only its matching opposite lane may join.
    if (run && (!race || slots !== 1 || run.raceKey !== race.key || run.lanes.has(race.lane))) {
      return { error: 'rate_limited', retryAfterSec: 1 };
    }
    const charges = this.charges.get(client) ?? [];
    let excess = charges.reduce((n, c) => n + c.count, 0) + slots - this.hourlyLimit;
    if (excess > 0) {
      let retryAfterSec = 3600;
      for (const charge of charges) {
        excess -= charge.count;
        if (excess <= 0) { retryAfterSec = Math.max(1, Math.ceil((charge.at + HOUR - now) / 1000)); break; }
      }
      return { error: 'rate_limited', retryAfterSec };
    }
    const mustWait = this.waiting.length > 0 || this.used + slots > this.maxConcurrent;
    if (slots > this.maxConcurrent || (mustWait && this.waiting.length >= this.maxQueue)) {
      return { error: 'busy', retryAfterSec: 30 };
    }
    const retryAfterSec = this.globalJobs.retryAfter('global');
    if (retryAfterSec) return { error: 'rate_limited', retryAfterSec };
    this.globalJobs.record('global');
    const charge = { at: now, count: slots };
    charges.push(charge);
    this.charges.set(client, charges);
    const clientRun = run ?? { raceKey: slots === 1 ? race?.key : undefined, lanes: new Set<string>(), jobs: 0 };
    if (race) clientRun.lanes.add(race.lane);
    clientRun.jobs++;
    this.clients.set(client, clientRun);
    let start!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    const entry: Entry = { client, slots, start, position: -1 };
    let released = false;
    this.waiting.push(entry);
    this.pump();
    return {
      ready,
      onPosition(listener) { entry.listener = listener; listener(entry.position); },
      release: () => {
        if (released) return;
        released = true;
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          // A disconnected waiting client consumed no upstream generations.
          const recent = this.charges.get(client);
          if (recent) this.charges.set(client, recent.filter(c => c !== charge));
          start();
        } else this.used -= slots;
        if (--clientRun.jobs === 0) this.clients.delete(client);
        entry.listener = undefined;
        this.pump();
      },
    };
  }

  private pump() {
    while (this.waiting.length && this.used + this.waiting[0].slots <= this.maxConcurrent) {
      const entry = this.waiting.shift()!;
      this.used += entry.slots;
      entry.position = 0;
      entry.listener?.(0);
      entry.start();
    }
    this.waiting.forEach((entry, index) => {
      if (entry.position !== index + 1) {
        entry.position = index + 1;
        entry.listener?.(entry.position);
      }
    });
  }
}
