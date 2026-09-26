// The one shared copy of the viewer's settings, so notes, lists and hidden rows
// follow you across machines and browsers instead of staying in one
// localStorage.
//
// Used by two hosts: `api/settings.js` on Vercel, and the dev-server middleware
// in `viewer/vite.config.js`. Both hand over a plain request description and
// get a status plus a JSON body back, so the logic exists once. The leading
// underscore keeps Vercel from deploying this file as an endpoint of its own.
//
// Storage is Upstash Redis over its REST API, called with plain `fetch`, so the
// repo root keeps no runtime dependencies. One hash holds the document, a
// revision counter and the time of the last write.

import { createHash, timingSafeEqual } from 'node:crypto';

const KEY = 'car-compare:settings';

// Upstash rejects bodies over 1 MB on the free plan; stay clear of that with a
// readable error instead of an opaque 413 from Redis.
const MAX_BYTES = 900_000;

// Compare-and-set in one round trip: a write only lands when it was based on
// the revision that is stored now. Otherwise the client gets the current
// revision back, pulls, merges and tries again, so two devices writing at once
// cannot silently overwrite each other.
const SAVE = `
local rev = tonumber(redis.call('HGET', KEYS[1], 'rev') or '0')
if rev ~= tonumber(ARGV[1]) then return {0, rev} end
rev = rev + 1
redis.call('HSET', KEYS[1], 'rev', rev, 'doc', ARGV[2], 'updatedAt', ARGV[3])
return {1, rev}
`;

const reply = (status, body) => ({ status, body });

/** The Vercel Upstash integration sets KV_*, a manually created database UPSTASH_*. */
function redisConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis({ url, token }, command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Redis HTTP ${res.status}`);
  return data.result;
}

/** Hashing first makes the comparison constant-time regardless of length. */
function authorized(header, expected) {
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{ method: string, authorization?: string, body?: unknown, env?: object }} request
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleSettings({ method, authorization, body, env = process.env }) {
  if (!env.SYNC_TOKEN) {
    return reply(503, { error: 'Sync ist auf dem Server nicht eingerichtet (SYNC_TOKEN fehlt).' });
  }
  const cfg = redisConfig(env);
  if (!cfg) {
    return reply(503, { error: 'Sync ist auf dem Server nicht eingerichtet (keine Redis-Datenbank).' });
  }
  if (!authorized(authorization, env.SYNC_TOKEN)) {
    return reply(401, { error: 'Der Sync-Schlüssel ist ungültig.' });
  }

  try {
    if (method === 'GET') {
      const [rev, doc, updatedAt] = await redis(cfg, ['HMGET', KEY, 'rev', 'doc', 'updatedAt']);
      return reply(200, {
        rev: Number(rev ?? 0),
        updatedAt: updatedAt ?? null,
        settings: doc ? JSON.parse(doc) : {},
      });
    }

    if (method === 'PUT') {
      const { baseRev, settings } = body ?? {};
      if (!Number.isInteger(baseRev) || !isPlainObject(settings)) {
        return reply(400, { error: 'Erwartet { baseRev, settings }.' });
      }
      const doc = JSON.stringify(settings);
      if (Buffer.byteLength(doc) > MAX_BYTES) {
        return reply(413, { error: 'Die Einstellungen sind zu groß für den Sync.' });
      }
      const updatedAt = new Date().toISOString();
      const [saved, rev] = await redis(cfg, ['EVAL', SAVE, '1', KEY, String(baseRev), doc, updatedAt]);
      if (!saved) return reply(409, { error: 'Zwischenzeitlich geändert.', rev: Number(rev) });
      return reply(200, { rev: Number(rev), updatedAt });
    }

    return reply(405, { error: `${method} wird nicht unterstützt.` });
  } catch (err) {
    return reply(502, { error: `Speicher nicht erreichbar: ${err.message}` });
  }
}
