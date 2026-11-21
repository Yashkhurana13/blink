export function createStatsTracker(start = performance.now()) {
  let first: number | undefined;
  let last: number | undefined;
  let chars = 0;
  let usage: number | undefined;

  return {
    recordDelta(text: string, now = performance.now()) {
      if (!text.length) return;
      first ??= now;
      last = now;
      chars += text.length;
    },
    setUsage(tokens: number) {
      usage = tokens;
    },
    finish(now = performance.now()) {
      const outputTokens = usage ?? Math.ceil(chars / 4);
      const duration = first === undefined || last === undefined ? 0 : last - first;
      return {
        ttftMs: first === undefined ? 0 : first - start,
        totalMs: now - start,
        outputTokens,
        tokensPerSecond: outputTokens < 2 || duration <= 0 ? 0 : (outputTokens - 1) / (duration / 1000),
        tokensEstimated: usage === undefined,
      };
    },
  };
}
