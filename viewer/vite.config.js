import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleSettings } from '../api/_settings-store.js';

const LISTINGS = path.resolve(import.meta.dirname, '../data/listings');

/**
 * Read the listings folder per request instead of bundling it into the app.
 * A `pnpm scrape` run then shows up on a plain reload, with no dev-server
 * restart and no copy of the data inside the viewer.
 */
async function readCars() {
  let files;
  try {
    files = (await readdir(LISTINGS)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const cars = await Promise.all(
    files.map(async (file) => {
      try {
        return JSON.parse(await readFile(path.join(LISTINGS, file), 'utf8'));
      } catch {
        return null; // A half-written file during a scrape must not kill the list.
      }
    }),
  );
  return cars.filter(Boolean);
}

const carsApi = () => {
  const middleware = async (req, res, next) => {
    if (!req.url.startsWith('/api/cars')) return next();
    const cars = await readCars();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ cars }));
  };
  return {
    name: 'cars-api',
    // Block bodies on purpose: `use()` returns the connect app, and vite would
    // mistake a returned function for a post-hook.
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    // A static host has no dev server to run the middleware, so the build
    // freezes the same response into a file. The URL stays `/api/cars.json`
    // either way; in dev the middleware answers it from disk on every request,
    // so a `pnpm scrape` run still shows up on a plain reload.
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'api/cars.json',
        source: JSON.stringify({ cars: await readCars() }),
      });
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

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    carsApi(),
    // '' loads every variable, not only VITE_*. They stay on the server: only
    // the middleware sees them, nothing is handed to the client bundle. The
    // shell wins over the .env files, as in Vite itself, so a one-off
    // `KV_REST_API_URL=… pnpm viewer` can point at a test store.
    settingsApi({ ...loadEnv(mode, path.resolve(import.meta.dirname, '..'), ''), ...process.env }),
  ],
  server: { port: 5180 },
}));
