export type UpstreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; completionTokens: number };

export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<UpstreamEvent> {
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
    const event = JSON.parse(data);
    if (event.error) throw new Error('Upstream stream error');
    const text = event.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text.length) yield { type: 'delta', text };
    const tokens = event.usage?.completion_tokens;
    if (Number.isInteger(tokens) && tokens >= 0) yield { type: 'usage', completionTokens: tokens };
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
}
