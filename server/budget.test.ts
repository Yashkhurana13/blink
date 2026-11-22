import assert from 'node:assert/strict';
import test from 'node:test';
import { UpstreamBudget } from './budget.ts';

const signal = () => new AbortController().signal;

test('rolling request budget queues attempts, updates positions, and expires each reservation at sixty seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const budget = new UpstreamBudget({ requestsPerMin: 2 });
  await budget.acquire(1, signal());
  t.mock.timers.tick(1000);
  await budget.acquire(1, signal());
  const positions: number[][] = [[], []];
  const third = budget.acquire(1, signal(), n => positions[0].push(n));
  const fourth = budget.acquire(1, signal(), n => positions[1].push(n));
  assert.deepEqual(positions, [[1], [2]]);
  t.mock.timers.tick(58_999);
  assert.deepEqual(positions, [[1], [2]]);
  t.mock.timers.tick(1);
  await third;
  assert.deepEqual(positions, [[1, 0], [2, 1]]);
  t.mock.timers.tick(1000);
  await fourth;
  assert.deepEqual(positions[1], [2, 1, 0]);
});

test('token budget is shared by all attempts, even when request capacity remains', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const budget = new UpstreamBudget({ tokensPerMin: 14_000 });
  await budget.acquire(7001, signal());
  const positions: number[] = [];
  const next = budget.acquire(7000, signal(), n => positions.push(n));
  assert.deepEqual(positions, [1]);
  t.mock.timers.tick(59_999);
  assert.deepEqual(positions, [1]);
  t.mock.timers.tick(1);
  await next;
  assert.deepEqual(positions, [1, 0]);
});

test('cancelling an attempt removes it without charging quota and advances the queue', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const budget = new UpstreamBudget({ requestsPerMin: 1 });
  await budget.acquire(7000, signal());
  const controller = new AbortController();
  const cancelled = budget.acquire(7000, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const positions: number[] = [];
  const next = budget.acquire(7000, signal(), n => positions.push(n));
  assert.deepEqual(positions, [2]);
  controller.abort();
  await rejected;
  assert.deepEqual(positions, [2, 1]);
  t.mock.timers.tick(60_000);
  await next;
  assert.deepEqual(positions, [2, 1, 0]);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(budget.acquire(7000, alreadyAborted.signal), { name: 'AbortError' });
});

for (const [header, delay] of [[null, 20_000], ['invalid', 20_000], ['-1', 20_000], ['3', 3000], ['Thu, 01 Jan 1970 00:00:05 GMT', 5000]] as const) {
  test(`429 pause honors Retry-After ${header} globally`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const budget = new UpstreamBudget();
    budget.pause(header);
    const positions: number[] = [];
    const attempt = budget.acquire(7000, signal(), n => positions.push(n));
    assert.deepEqual(positions, [1]);
    t.mock.timers.tick(delay - 1);
    assert.deepEqual(positions, [1]);
    t.mock.timers.tick(1);
    assert.deepEqual(positions, [1, 0]);
    await attempt;
    assert.deepEqual(positions, [1, 0]);
  });
}

test('a later shorter Retry-After cannot shorten an existing global pause', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const budget = new UpstreamBudget();
  budget.pause('10');
  const positions: number[] = [];
  const attempt = budget.acquire(7000, signal(), n => positions.push(n));
  budget.pause('1');
  t.mock.timers.tick(9999);
  assert.deepEqual(positions, [1]);
  t.mock.timers.tick(1);
  await attempt;
});

test('default budgets allow eighty requests or ninety thousand estimated tokens per minute', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  for (const [tokens, allowed] of [[1, 80], [7000, 12]]) {
    const budget = new UpstreamBudget();
    for (let i = 0; i < allowed; i++) await budget.acquire(tokens, signal());
    const positions: number[] = [];
    const next = budget.acquire(tokens, signal(), n => positions.push(n));
    assert.deepEqual(positions, [1]);
    t.mock.timers.tick(60_000);
    await next;
    assert.deepEqual(positions, [1, 0]);
  }
});
