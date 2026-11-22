type Attempt = {
  tokens: number; start: (charge: Charge) => void; position?: number; onPosition?: (n: number) => void;
};
type Charge = { at: number; tokens: number };
const MINUTE = 60_000;

// A reservation covers one upstream attempt, including attempts that fail or retry.
export class UpstreamBudget {
  private charges: Charge[] = [];
  private waiting: Attempt[] = [];
  private pausedUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private requestsPerMin: number;
  private tokensPerMin: number;

  constructor(options: { requestsPerMin?: number; tokensPerMin?: number } = {}) {
    this.requestsPerMin = options.requestsPerMin ?? 80;
    this.tokensPerMin = options.tokensPerMin ?? 90_000;
  }

  acquire(tokens: number, signal: AbortSignal, onPosition?: (position: number) => void): Promise<(actualTokens: number) => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(signal.reason);
        this.pump();
      };
      const entry: Attempt = { tokens, onPosition, start: charge => {
        signal.removeEventListener('abort', abort);
        resolve(actualTokens => {
          if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) return;
          charge.tokens = actualTokens;
          this.pump();
        });
      } };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  pause(retryAfter: string | null) {
    const now = Date.now();
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const date = Number.isNaN(seconds) && retryAfter ? Date.parse(retryAfter) : NaN;
    const until = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000
      : Number.isFinite(date) ? Math.max(now, date) : now + 20_000;
    this.pausedUntil = Math.max(this.pausedUntil, until);
    this.pump();
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    this.charges = this.charges.filter(charge => now - charge.at < MINUTE);
    let tokens = this.charges.reduce((sum, charge) => sum + charge.tokens, 0);
    while (this.waiting.length && now >= this.pausedUntil
      && this.charges.length < this.requestsPerMin && tokens + this.waiting[0].tokens <= this.tokensPerMin) {
      const entry = this.waiting.shift()!;
      const charge = { at: now, tokens: entry.tokens };
      this.charges.push(charge);
      tokens += entry.tokens;
      if (entry.position !== undefined) entry.onPosition?.(0);
      entry.start(charge);
    }
    this.waiting.forEach((entry, index) => {
      if (entry.position !== index + 1) {
        entry.position = index + 1;
        entry.onPosition?.(entry.position);
      }
    });
    if (!this.waiting.length) return;
    let at = Math.max(now, this.pausedUntil);
    let requests = this.charges.length;
    for (const charge of this.charges) {
      if (requests < this.requestsPerMin && tokens + this.waiting[0].tokens <= this.tokensPerMin) break;
      at = Math.max(at, charge.at + MINUTE);
      requests--;
      tokens -= charge.tokens;
    }
    // A configured budget smaller than a single estimate cannot admit it; it remains cancellable.
    if (this.waiting[0].tokens > this.tokensPerMin) return;
    this.timer = setTimeout(() => this.pump(), Math.min(2_147_483_647, Math.max(1, at - now)));
    this.timer.unref?.();
  }
}
