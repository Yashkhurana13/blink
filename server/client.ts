import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

export function dataDirectory(env: NodeJS.ProcessEnv) {
  return resolve(env.BLINK_DATA_DIR || './data');
}

export function createClientIdentity(env: NodeJS.ProcessEnv = process.env) {
  let salt = env.BLINK_SALT;
  if (!salt) {
    const dir = dataDirectory(env);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'salt');
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    salt = readFileSync(file, 'utf8');
    if (!salt) throw new Error('Blink salt is empty');
  }
  return (req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? '';
    const ipv4 = peer.replace(/^::ffff:/i, '');
    const loopback = peer === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
    const forwarded = req.headers['cf-connecting-ip'];
    const ip = loopback && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
    return createHash('sha256').update(salt).update(ip).digest('hex');
  };
}
