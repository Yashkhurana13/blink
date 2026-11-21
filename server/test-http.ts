import assert from 'node:assert/strict';
import { Agent, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex, PassThrough, Readable } from 'node:stream';
import type { TestContext } from 'node:test';

// Exercise node:http's actual request/response parsing without opening a socket.
// The sandbox blocks TCP and IPC listeners, so only fetch's transport is replaced.
export function httpHarness(t: TestContext) {
  const servers = new Map<string, Server>();
  const sockets: Duplex[] = [];
  const agents: Agent[] = [];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    for (const agent of agents) agent.destroy();
  });
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const server = servers.get(new URL(url).origin);
    assert.ok(server, `Unknown test upstream: ${new URL(url).origin}`);
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const client = Duplex.from({ readable: incoming, writable: outgoing });
    const peer = Duplex.from({ readable: outgoing, writable: incoming });
    for (const socket of [client, peer]) Object.assign(socket, {
      setTimeout: () => socket, setNoDelay: () => socket, setKeepAlive: () => socket,
    });
    sockets.push(client, peer);
    const agent = new Agent();
    agents.push(agent);
    agent.createConnection = () => {
      server.emit('connection', peer);
      return client as Socket;
    };
    const req = request(url, {
      method: init.method, headers: Object.fromEntries(new Headers(init.headers)), agent,
    }, res => {
      const headers = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode, headers }));
      res.once('close', () => init.signal?.removeEventListener('abort', abort));
    });
    const abort = () => req.destroy(new Error('Request aborted'));
    req.on('error', reject);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    req.end(init.body);
  }));
  return (server: Server) => {
    const origin = `http://blink-test-${servers.size + 1}`;
    servers.set(origin, server);
    return origin;
  };
}
