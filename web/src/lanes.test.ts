import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRaceLanes } from './lanes.ts';

test('leaves both lanes empty for a new race', () => {
  const cerebras = Object.freeze({ html: '', conversationId: 'cerebras' });
  const compare = Object.freeze({ html: '', conversationId: 'compare' });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'unused', true), [cerebras, compare]);
});

for (const refreshCompare of [true, false]) {
  test(`seeds an empty comparison lane when ${refreshCompare ? 'enabling Race' : 'submitting a race remix'}`, () => {
    const cerebras = Object.freeze({ html: '<html>solo remix</html>', conversationId: 'cerebras' });
    const compare = Object.freeze({ html: '', conversationId: 'compare' });
    assert.deepEqual(syncRaceLanes(cerebras, compare, 'new-compare', refreshCompare), [
      cerebras, { html: '<html>solo remix</html>', conversationId: 'new-compare' },
    ]);
  });
}

test('seeds Cerebras from comparison when only the comparison lane has an app', () => {
  const cerebras = Object.freeze({ html: '', conversationId: 'cerebras' });
  const compare = Object.freeze({ html: '<html>comparison app</html>', conversationId: 'compare' });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'new-cerebras'), [
    { html: '<html>comparison app</html>', conversationId: 'new-cerebras' }, compare,
  ]);
});

test('re-enabling Race replaces stale comparison HTML after solo remixes with a fresh conversation', () => {
  const initial = { html: '<html>first app</html>', conversationId: 'cerebras' };
  const [, comparison] = syncRaceLanes(initial, { html: '', conversationId: 'compare' }, 'first-compare', true);
  const soloRemix = Object.freeze({ html: '<html>latest solo remix</html>', conversationId: 'cerebras' });
  assert.deepEqual(syncRaceLanes(soloRemix, Object.freeze(comparison), 'second-compare', true), [
    soloRemix, { html: '<html>latest solo remix</html>', conversationId: 'second-compare' },
  ]);
});

test('submitting a race remix preserves each existing lane app and conversation', () => {
  const cerebras = Object.freeze({ html: '<html>Cerebras version</html>', conversationId: 'cerebras' });
  const compare = Object.freeze({ html: '<html>comparison version</html>', conversationId: 'compare' });
  assert.deepEqual(syncRaceLanes(cerebras, compare, 'unused'), [cerebras, compare]);
});
