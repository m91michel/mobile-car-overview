import { execSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleSettings } from '../api/_settings-store.js';

const DATA = path.resolve(import.meta.dirname, '../data');

// A collection is any folder `data/<id>/` holding a `collection.json` (name,
// icon, labels) and a `listings/` folder with one JSON file per item. The id
// becomes part of a URL and of localStorage keys, hence the narrow pattern.
const COLLECTION_ID = /^[a-z0-9][a-z0-9-]*$/;

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // A half-written file during a scrape must not kill the list.
  }
};

/**
 * Read a listings folder per request instead of bundling it into the app.
 * A `pnpm scrape` run then shows up on a plain reload, with no dev-server
 * restart and no copy of the data inside the viewer.
 */
async function readItems(id) {
  if (!COLLECTION_ID.test(id)) return [];
  const dir = path.join(DATA, id, 'listings');
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const items = await Promise.all(files.map((file) => readJson(path.join(dir, file))));
  return items.filter(Boolean);
}

/** Every collection with its metadata, item count and a few cover photos. */
async function readCollections() {
  let dirs;
  try {
    dirs = (await readdir(DATA, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const found = await Promise.all(
    dirs
      .filter((d) => COLLECTION_ID.test(d.name))
      .map(async (d) => {
        const meta = await readJson(path.join(DATA, d.name, 'collection.json'));
        if (!meta) return null;
        const items = await readItems(d.name);
        const live = items.filter((item) => item.availability?.status !== 'sold');
        return {
          ...meta,
          id: d.name,
          count: live.length,
          covers: live.map((item) => item.images?.[0]).filter(Boolean).slice(0, 3),
        };
      }),
  );
  return found
    .filter(Boolean)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'de'));
}

const collectionsApi = () => {
  const send = (res, body) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const middleware = async (req, res, next) => {
    const url = req.url.split('?')[0];
    if (url === '/api/collections.json') return send(res, { collections: await readCollections() });
    const match = /^\/api\/collections\/([^/]+)\.json$/.exec(url);
    if (match) return send(res, { items: await readItems(match[1]) });
    // The URL every build before collections fetched. An open tab or an
    // installed app keeps that bundle until its next reload.
    if (url.startsWith('/api/cars')) return send(res, { cars: await readItems('cars') });
    return next();
  };
  return {
    name: 'collections-api',
    // Block bodies on purpose: `use()` returns the connect app, and vite would
    // mistake a returned function for a post-hook.
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    // A static host has no dev server to run the middleware, so the build
    // freezes the same responses into files under the same URLs. In dev the
    // middleware answers them from disk on every request, so a `pnpm scrape`
    // run still shows up on a plain reload.
    async generateBundle() {
      const collections = await readCollections();
      const emit = (fileName, body) =>
        this.emitFile({ type: 'asset', fileName, source: JSON.stringify(body) });
      emit('api/collections.json', { collections });
      for (const { id } of collections) {
        emit(`api/collections/${id}.json`, { items: await readItems(id) });
      }
      emit('api/cars.json', { cars: await readItems('cars') });
    },
  };
};

/**
 * The settings sync, answered by the same handler Vercel runs. With the Redis
 * and SYNC_TOKEN variables in the repo's `.env.local` (`vercel env pull`), the
 * dev server reads and writes the very store the deployed site uses, so
 * localhost and the Vercel URL show the same notes.
 */
const settingsApi = (env) => {
  const middleware = async (req, res, next) => {
    if (!req.url.startsWith('/api/settings')) return next();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined; // handleSettings answers 400 for a missing body.
    }
    const result = await handleSettings({
      method: req.method,
      authorization: req.headers.authorization,
      body,
      scope: new URL(req.url, 'http://localhost').searchParams.get('scope') ?? undefined,
      env,
    });
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(result.body));
  };
  return {
    name: 'settings-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
};

/**
 * The commit this bundle is built from, compared against /api/health at run
 * time (UpdateNotice.jsx). Vercel provides it as a variable; a local build
 * asks git, and a checkout without git gets null, which turns the check off.
 */
function buildVersion() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [
    react(),
    collectionsApi(),
    // '' loads every variable, not only VITE_*. They stay on the server: only
    // the middleware sees them, nothing is handed to the client bundle. The
    // shell wins over the .env files, as in Vite itself, so a one-off
    // `KV_REST_API_URL=… pnpm viewer` can point at a test store.
    settingsApi({ ...loadEnv(mode, path.resolve(import.meta.dirname, '..'), ''), ...process.env }),
  ],
  server: { port: 5180 },
}));
