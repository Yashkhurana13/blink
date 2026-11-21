import { readFile } from 'node:fs/promises';
import { buildMessages } from './prompt.ts';

export type GenerateRequest = {
  prompt: string;
  conversationId?: string;
  currentHtml?: string;
  lane: 'cerebras' | 'compare';
};

export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  const compareEnabled = Boolean(env.COMPARE_BASE_URL && env.COMPARE_API_KEY && env.COMPARE_MODEL && env.COMPARE_LABEL);
  return { compareEnabled, compareLabel: compareEnabled ? env.COMPARE_LABEL! : null };
}

export async function buildLaneRequest(input: GenerateRequest, env: NodeJS.ProcessEnv = process.env) {
  const compare = input.lane === 'compare';
  const base = compare ? env.COMPARE_BASE_URL! : (env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789');
  const token = compare ? env.COMPARE_API_KEY : env.OPENCLAW_GATEWAY_TOKEN;
  const messages = buildMessages(input.prompt, input.currentHtml);
  if (compare) messages.unshift({
    role: 'system', content: await readFile(new URL('../agent/AGENTS.md', import.meta.url), 'utf8'),
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: `${base.replace(/\/+$/, '')}${compare ? '/chat/completions' : '/v1/chat/completions'}`,
    headers,
    body: JSON.stringify({
      model: compare ? env.COMPARE_MODEL : 'openclaw/blink',
      stream: true,
      user: input.conversationId,
      messages,
    }),
  };
}
