import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

export function dataDirectory(env: NodeJS.ProcessEnv) {
  return resolve(env.BLINK_DATA_DIR || './data');
}

function loadSalt(env: NodeJS.ProcessEnv) {
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
  return salt;
}

function canonicalIp(ip: string) {
  if (isIP(ip) !== 6) return ip;
  const canonical = new URL(`http://[${ip.split('%')[0]}]`).hostname.slice(1, -1);
  // URL canonicalization converts both dotted and hexadecimal IPv4-mapped forms.
  const mapped = canonical.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return canonical;
  return mapped.slice(1).flatMap(part => {
    const n = parseInt(part, 16);
    return [n >>> 8, n & 255];
  }).join('.');
}

function abuseIp(ip: string) {
  const canonical = canonicalIp(ip);
  if (isIP(canonical) !== 6) return canonical;
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return `${parts.slice(0, 4).map(part => part.padStart(4, '0')).join(':')}::/64`;
}

export function createClientIdentity(env: NodeJS.ProcessEnv = process.env) {
  const salt = loadSalt(env);
  return (req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? '';
    const canonical = canonicalIp(peer);
    const loopback = canonical === '::1' || (isIP(canonical) === 4 && canonical.startsWith('127.'));
    const forwarded = req.headers['cf-connecting-ip'];
    const ip = loopback && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
    return createHash('sha256').update(salt).update(abuseIp(ip)).digest('hex');
  };
}

export function createCreatorIdentity(env: NodeJS.ProcessEnv = process.env) {
  const salt = loadSalt(env);
  return (req: IncomingMessage, res: ServerResponse) => {
    let credential = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith('blink_creator='))?.slice('blink_creator='.length);
    if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)
      || Buffer.from(credential, 'base64url').toString('base64url') !== credential) {
      credential = randomBytes(32).toString('base64url');
      res.setHeader('Set-Cookie', `blink_creator=${credential}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${env.BLINK_PUBLIC_ORIGIN?.startsWith('https') ? '; Secure' : ''}`);
    }
    return createHash('sha256').update(salt).update(credential).digest('hex');
  };
}
