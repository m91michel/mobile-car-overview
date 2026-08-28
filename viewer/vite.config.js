import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  };
};

export default defineConfig({
  plugins: [react(), carsApi()],
  server: { port: 5180 },
});
