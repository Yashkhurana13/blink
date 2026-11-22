import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaneRequest } from './lanes.ts';

test('defaults the gateway to the local OpenClaw chat-completions endpoint', async () => {
  const request = await buildLaneRequest({ prompt: 'a clock', conversationId: 'id', lane: 'cerebras' }, {});
  assert.equal(request.url, 'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(request.headers.Authorization, undefined);
});

test('upstream token reservation includes fixed prompt overhead, input rounded up by thirds, and the output ceiling', async () => {
  const request = await buildLaneRequest({ prompt: '1234567890' }, {});
  assert.equal(request.estimatedTokens, 13_004);
});

for (const lane of ['cerebras', 'compare'] as const) {
  for (const overrides of [{}, { MAX_OUTPUT_TOKENS: '8000', PROMPT_OVERHEAD_TOKENS: '4200' }, { MAX_OUTPUT_TOKENS: '-1', PROMPT_OVERHEAD_TOKENS: 'bad' }]) {
    test(`${lane} sends an output ceiling and reserves all input, including remix HTML (${JSON.stringify(overrides)})`, async () => {
      const request = await buildLaneRequest({ prompt: 'blue', currentHtml: '<html>' + 'x'.repeat(30_000) + '</html>', lane }, {
        COMPARE_BASE_URL: 'http://provider/v1', COMPARE_MODEL: 'model', ...overrides,
      });
      const body = JSON.parse(request.body);
      const output = overrides.MAX_OUTPUT_TOKENS === '8000' ? 8000 : 9000;
      const overhead = overrides.PROMPT_OVERHEAD_TOKENS === '4200' ? 4200 : 4000;
      assert.equal(body.max_tokens, output);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.equal(request.estimatedTokens, overhead + Math.ceil(body.messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0) / 3) + output);
    });
  }
}
