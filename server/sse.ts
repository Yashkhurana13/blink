export type UpstreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; completionTokens: number; promptTokens?: number };

export function* parseCompletion(data: string): Generator<UpstreamEvent> {
  const event = JSON.parse(data);
  const choice = event.choices?.[0];
  const text = choice?.delta?.content ?? choice?.message?.content;
  if (typeof text === 'string' && text.length) yield { type: 'delta', text };
  const tokens = event.usage?.completion_tokens;
  const promptTokens = event.usage?.prompt_tokens;
  if (Number.isSafeInteger(tokens) && tokens >= 0) yield {
    type: 'usage', completionTokens: tokens,
    ...(Number.isSafeInteger(promptTokens) && promptTokens >= 0 ? { promptTokens } : {}),
  };
  if (event.error || choice?.finish_reason === 'length') throw new Error('Upstream stream error');
}

export async function* parseSse(chunks: AsyncIterable<Uint8Array>, requireDone = false): AsyncGenerator<UpstreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  function* parseLine(line: string): Generator<UpstreamEvent | 'done'> {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      yield 'done';
      return;
    }
    yield* parseCompletion(data);
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      for (const event of parseLine(line)) {
        if (event === 'done') return;
        yield event;
      }
    }
  }
  buffer += decoder.decode();
  for (const event of parseLine(buffer)) {
    if (event === 'done') return;
    yield event;
  }
  if (requireDone) throw new Error('Upstream stream ended before completion');
}
