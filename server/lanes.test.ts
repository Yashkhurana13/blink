import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaneRequest } from './lanes.ts';

test('defaults the gateway to the local OpenClaw chat-completions endpoint', async () => {
  const request = await buildLaneRequest({ prompt: 'a clock', conversationId: 'id', lane: 'cerebras' }, {});
  assert.equal(request.url, 'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(request.headers.Authorization, undefined);
});

test('upstream token reservation includes input characters rounded up plus seven thousand output tokens', async () => {
  const request = await buildLaneRequest({ prompt: '123456789' }, {});
  assert.equal(request.estimatedTokens, 7003);
});
