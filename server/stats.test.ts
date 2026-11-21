import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatsTracker } from './stats.ts';

test('uses reported output tokens and first/last delta times for throughput', () => {
  const tracker = createStatsTracker(100);
  tracker.recordDelta('hello', 200);
  tracker.recordDelta(' world', 700);
  tracker.setUsage(11);
  assert.deepEqual(tracker.finish(900), {
    ttftMs: 100, totalMs: 800, outputTokens: 11, tokensPerSecond: 20, tokensEstimated: false,
  });
});

test('estimates tokens with ceil(chars / 4), ignoring empty deltas', () => {
  const tracker = createStatsTracker(0);
  tracker.recordDelta('', 50);
  tracker.recordDelta('abcd', 100);
  tracker.recordDelta('e', 1100);
  assert.deepEqual(tracker.finish(1200), {
    ttftMs: 100, totalMs: 1200, outputTokens: 2, tokensPerSecond: 1, tokensEstimated: true,
  });
});

test('empty, single-token and simultaneous-delta streams have finite zero throughput', () => {
  const empty = createStatsTracker(0);
  assert.deepEqual(empty.finish(10), {
    ttftMs: 0, totalMs: 10, outputTokens: 0, tokensPerSecond: 0, tokensEstimated: true,
  });
  empty.setUsage(0);
  assert.equal(empty.finish(10).tokensEstimated, false);
  const single = createStatsTracker(0);
  single.recordDelta('a', 1);
  single.recordDelta('b', 2);
  assert.equal(single.finish(3).tokensPerSecond, 0);
  single.setUsage(10);
  const simultaneous = createStatsTracker(0);
  simultaneous.recordDelta('hello world', 5);
  assert.equal(simultaneous.finish(10).tokensPerSecond, 0);
});
