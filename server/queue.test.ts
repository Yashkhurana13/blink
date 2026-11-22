import assert from 'node:assert/strict';
import test from 'node:test';
import { Scheduler, type Job } from './queue.ts';

function job(value: ReturnType<Scheduler['reserve']>): Job {
  assert.ok(!('error' in value));
  return value;
}

test('FIFO fairness reserves all variant slots and updates waiting positions', async () => {
  const queue = new Scheduler({ maxConcurrent: 4 });
  const first = job(queue.reserve('a', 1));
  const second = job(queue.reserve('b', 4));
  const third = job(queue.reserve('c', 1));
  const positions: number[][] = [[], []];
  second.onPosition(n => positions[0].push(n));
  third.onPosition(n => positions[1].push(n));
  assert.deepEqual(positions, [[1], [2]]);
  first.release();
  await second.ready;
  assert.deepEqual(positions, [[1, 0], [2, 1]]);
  second.release();
  await third.ready;
  assert.deepEqual(positions[1], [2, 1, 0]);
  third.release();
});

test('active/queued client, queue capacity, and impossible slot requests are rejected', () => {
  const queue = new Scheduler({ maxConcurrent: 1, maxQueue: 1 });
  const first = job(queue.reserve('a', 1));
  assert.equal((queue.reserve('a', 1) as any).error, 'rate_limited');
  const waiting = job(queue.reserve('b', 1));
  assert.equal((queue.reserve('b', 1) as any).error, 'rate_limited');
  assert.equal((queue.reserve('c', 1) as any).error, 'busy');
  waiting.release();
  const next = job(queue.reserve('c', 1));
  next.release();
  first.release();
  assert.equal((queue.reserve('d', 4) as any).error, 'busy');
});

test('rolling hourly limit counts x4 as four and expires with fake time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const queue = new Scheduler({ hourlyLimit: 5 });
  job(queue.reserve('a', 4)).release();
  t.mock.timers.tick(1000);
  job(queue.reserve('a', 1)).release();
  assert.deepEqual(queue.reserve('a', 1), { error: 'rate_limited', retryAfterSec: 3599 });
  assert.deepEqual(queue.reserve('a', 4), { error: 'rate_limited', retryAfterSec: 3599 });
  t.mock.timers.tick(3_599_000);
  job(queue.reserve('a', 4)).release();
  assert.equal((queue.reserve('a', 1) as any).error, 'rate_limited');
});

test('cancelling a queued job removes it, refunds quota, and advances positions', async () => {
  const queue = new Scheduler({ maxConcurrent: 1, hourlyLimit: 1 });
  const first = job(queue.reserve('a', 1));
  const cancelled = job(queue.reserve('b', 1));
  const next = job(queue.reserve('c', 1));
  const positions: number[] = [];
  next.onPosition(n => positions.push(n));
  cancelled.release();
  assert.deepEqual(positions, [2, 1]);
  const requeued = job(queue.reserve('b', 1));
  first.release();
  await next.ready;
  next.release();
  await requeued.ready;
  requeued.release();
});

test('a matching race pair is one client run, with both lanes charged and slots bounded', async () => {
  const queue = new Scheduler({ maxConcurrent: 1, hourlyLimit: 2 });
  const first = job(queue.reserve('a', 1, { key: 'idea', lane: 'cerebras' }));
  const compare = job(queue.reserve('a', 1, { key: 'idea', lane: 'compare' }));
  const positions: number[] = [];
  compare.onPosition(n => positions.push(n));
  assert.deepEqual(positions, [1]);
  assert.equal((queue.reserve('a', 1, { key: 'idea', lane: 'compare' }) as any).error, 'rate_limited');
  assert.equal((queue.reserve('a', 1, { key: 'different', lane: 'cerebras' }) as any).error, 'rate_limited');
  first.release();
  await compare.ready;
  assert.deepEqual(positions, [1, 0]);
  assert.equal((queue.reserve('a', 1) as any).error, 'rate_limited');
  compare.release();
  assert.equal((queue.reserve('a', 1) as any).error, 'rate_limited');
});

test('defaults allow eight upstream slots, forty waiting jobs, and thirty generations per hour', () => {
  const queue = new Scheduler({ globalJobsPerMin: 100 });
  const active = Array.from({ length: 8 }, (_, i) => job(queue.reserve(`active-${i}`, 1)));
  const waiting = Array.from({ length: 40 }, (_, i) => job(queue.reserve(`waiting-${i}`, 1)));
  assert.equal((queue.reserve('overflow', 1) as any).error, 'busy');
  for (const ticket of waiting) ticket.release();
  for (const ticket of active) ticket.release();
  for (let i = 0; i < 30; i++) job(queue.reserve('capped', 1)).release();
  assert.equal((queue.reserve('capped', 1) as any).error, 'rate_limited');
});

test('global admission counts jobs across identities and expires after a rolling minute', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const queue = new Scheduler({ globalJobsPerMin: 2 });
  job(queue.reserve('a', 4)).release();
  t.mock.timers.tick(1000);
  job(queue.reserve('b', 1)).release();
  assert.deepEqual(queue.reserve('rotated', 1), { error: 'rate_limited', retryAfterSec: 59 });
  t.mock.timers.tick(59_000);
  job(queue.reserve('c', 1)).release();
  assert.deepEqual(queue.reserve('d', 1), { error: 'rate_limited', retryAfterSec: 1 });
});

test('default global admission admits forty new jobs per minute across identities', () => {
  const queue = new Scheduler();
  for (let i = 0; i < 40; i++) job(queue.reserve(`client-${i}`, 1)).release();
  assert.deepEqual(queue.reserve('overflow', 1), { error: 'rate_limited', retryAfterSec: 60 });
});
