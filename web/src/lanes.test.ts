import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRaceLanes } from './lanes.ts';

test('leaves both lanes empty for a new race', () => {
  const cerebras = Object.freeze({ html: '', conversationId: 'cerebras', soloRevision: 0 });
  const compare = Object.freeze({ html: '', conversationId: 'compare', soloRevision: 0 });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'unused'), [cerebras, compare]);
});

for (const refreshCompare of [true, false]) {
  test(`seeds an empty comparison lane when ${refreshCompare ? 'enabling Race' : 'submitting a race remix'}`, () => {
    const cerebras = Object.freeze({ html: '<html>solo remix</html>', conversationId: 'cerebras', soloRevision: 0 });
    const compare = Object.freeze({ html: '', conversationId: 'compare', soloRevision: 0 });
    assert.deepEqual(syncRaceLanes(cerebras, compare, 'new-compare'), [
      cerebras, { html: '<html>solo remix</html>', conversationId: 'new-compare', soloRevision: 0 },
    ]);
  });
}

test('seeds Cerebras from comparison when only the comparison lane has an app', () => {
  const cerebras = Object.freeze({ html: '', conversationId: 'cerebras', soloRevision: 0 });
  const compare = Object.freeze({ html: '<html>comparison app</html>', conversationId: 'compare', soloRevision: 0 });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'new-cerebras'), [
    { html: '<html>comparison app</html>', conversationId: 'new-cerebras', soloRevision: 0 }, compare,
  ]);
});

test('re-enabling Race replaces stale comparison HTML after solo remixes with a fresh conversation', () => {
  const initial = { html: '<html>first app</html>', conversationId: 'cerebras', soloRevision: 0 };
  const [, comparison] = syncRaceLanes(initial, { html: '', conversationId: 'compare', soloRevision: 0 }, 'first-compare');
  const soloRemix = Object.freeze({ html: '<html>latest solo remix</html>', conversationId: 'cerebras', soloRevision: 2 });
  assert.deepEqual(syncRaceLanes(soloRemix, Object.freeze(comparison), 'second-compare'), [
    soloRemix, { html: '<html>latest solo remix</html>', conversationId: 'second-compare', soloRevision: 2 },
  ]);
});

test('submitting a race remix preserves each existing lane app and conversation', () => {
  const cerebras = Object.freeze({ html: '<html>Cerebras version</html>', conversationId: 'cerebras', soloRevision: 0 });
  const compare = Object.freeze({ html: '<html>comparison version</html>', conversationId: 'compare', soloRevision: 0 });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'unused'), [cerebras, compare]);
});

test('toggling Race off and on without a solo edit preserves comparison app, stats, and conversation', () => {
  const cerebras = Object.freeze({ html: '<html>Cerebras result</html>', conversationId: 'cerebras', soloRevision: 1 });
  const compare = Object.freeze({ html: '<html>Comparison result</html>', conversationId: 'compare', soloRevision: 1,
    stats: { outputTokens: 900 } });
  const [nextCerebras, nextCompare] = syncRaceLanes(cerebras, compare, 'unused');
  assert.equal(nextCerebras, cerebras);
  assert.equal(nextCompare, compare);
});
