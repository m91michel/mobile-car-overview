#!/usr/bin/env node
// Check whether the cars in the comparison are still on offer.
//
//   pnpm available
//   pnpm available -- --max-age 12
//
// Flags:
//   --max-age <hours>   skip cars checked more recently than this
//   --delay <ms>        pause between listings per worker (default 4000, jittered)
//   --retries <n>       retries after a bot-block (default 1)
//   --cooloff <ms>      first wait after a bot-block, grows per retry (default 60000)
//   --concurrency <n>   parallel tabs (default 1; keep low to stay unremarkable)
//
// Much cheaper than pnpm refresh: it only asks the page whether the listing
// still exists and never re-parses it.
//
// It is also deliberately slow. Checking 29 listings back to back earned an
// Akamai block once already; the delay is jittered and the run gives up
// entirely after a few blocks in a row rather than grinding through them,
// because every retry while blocked only digs the hole deeper. A sold car keeps the data it was
// scraped with and is marked instead of deleted, so the viewer can grey it out
// and the comparison still reads as it did when the car was live.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ensureChrome, PORT } from './chrome.mjs';
import { openPage } from './cdp.mjs';
/**
 * Deliberately not extract.mjs's LISTING_READY_PROBE. That one waits for the
 * complete RSC payload because it is about to parse it, and on a repeat visit
 * the payload is served from cache and never re-pushed - so a live listing
 * sits at 'pending' until the timeout. Availability only needs the title,
 * which is there in about half a second.
 */
const AVAILABILITY_PROBE = `(() => {
  const title = document.title || '';
  if (title.includes('Zugriff verweigert')) return 'blocked';
  if (/nicht verf\\u00fcgbar/i.test(title)) return 'unavailable';
  if (document.readyState !== 'complete') return 'pending';
  return title.trim() && title !== 'about:blank' ? 'ready' : 'pending';
})()`;

const OUT_DIR = resolve('data/listings');
const INDEX_FILE = resolve('data/cars.json');
const DETAIL_URL = (id) =>
  `https://suchen.mobile.de/fahrzeuge/details.html?id=${id}&scopeId=C&action=compareItem`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A metronome is exactly what a bot looks like; spread the gap by +-40%.
const jittered = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

// Three blocks in a row means the whole run is being refused, not one page.
const BLOCK_LIMIT = 3;
let consecutiveBlocks = 0;
let abandoned = false;

function parseArgs(argv) {
  const options = { maxAgeHours: null, delayMs: 4000, retries: 1, cooloffMs: 60000, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const value = () => argv[++i];
    switch (argv[i]) {
      case '--': break; // pnpm forwards the separator itself
      case '--max-age': options.maxAgeHours = Number(value()); break;
      case '--delay': options.delayMs = Number(value()); break;
      case '--retries': options.retries = Number(value()); break;
      case '--cooloff': options.cooloffMs = Number(value()); break;
      case '--concurrency': options.concurrency = Math.max(1, Number(value())); break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (!existsSync(OUT_DIR)) {
  console.error('No data/listings yet - run pnpm saved or pnpm scrape first.');
  process.exit(1);
}

const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
let cars = files.map((file) => ({
  path: resolve(OUT_DIR, file),
  car: JSON.parse(readFileSync(resolve(OUT_DIR, file), 'utf8')),
}));

let skipped = 0;
if (options.maxAgeHours) {
  const cutoff = Date.now() - options.maxAgeHours * 3600_000;
  const before = cars.length;
  // No fallback to 0 here: Date.parse(0) parses the *string* "0" as the year
  // 2000, which would count a never-checked car as freshly checked.
  cars = cars.filter(({ car }) => !(Date.parse(car.availability?.checkedAt ?? '') >= cutoff));
  skipped = before - cars.length;
  if (skipped) console.log(`Skipping ${skipped} car(s) checked in the last ${options.maxAgeHours}h.`);
}

if (!cars.length) {
  console.log('Everything was checked recently enough.');
  process.exit(0);
}

await ensureChrome(PORT);

const workerCount = Math.min(options.concurrency, cars.length);
console.log(`Checking ${cars.length} listing(s)...`);

const queue = [...cars];
const results = [];
let done = 0;

async function worker() {
  const page = await openPage(PORT, { newTab: workerCount > 1 });
  try {
    while (queue.length && !abandoned) {
      const { path, car } = queue.shift();
      let status = null;
      let failure = null;

      // Akamai starts serving "Zugriff verweigert" after a run of quick
      // requests. That says nothing about the car, so sit it out and retry
      // rather than recording a verdict.
      for (let attempt = 0; ; attempt++) {
        let probe;
        try {
          await page.goto(car.url ?? car.sourceUrl ?? DETAIL_URL(car.id));
          probe = await page.waitForStatus(AVAILABILITY_PROBE, { timeoutMs: 20000 });
        } catch (error) {
          failure = error.message;
          break;
        }
        if (probe === 'ready') { status = 'available'; break; }
        if (probe === 'unavailable') { status = 'sold'; break; }
        if (probe === 'blocked' && attempt < options.retries) {
          const wait = options.cooloffMs * (attempt + 1);
          console.log(`        bot-block, waiting ${Math.round(wait / 1000)}s before retry`);
          await sleep(wait);
          continue;
        }
        failure = probe === 'blocked' ? 'bot-block' : 'no verdict before timeout';
        break;
      }

      if (failure === 'bot-block') {
        if (++consecutiveBlocks >= BLOCK_LIMIT) abandoned = true;
      } else if (status) {
        consecutiveBlocks = 0;
      }

      const was = car.availability?.status ?? null;
      if (status) {
        car.availability = { status, checkedAt: new Date().toISOString() };
        writeFileSync(path, JSON.stringify(car, null, 2));
      }
      results.push({ id: car.id, ref: car.ref, title: car.shortTitle, was, status, failure });

      const label = status ?? 'unknown';
      const changed = status && was && status !== was ? '  <- changed' : '';
      console.log(
        `  [${++done}/${cars.length}] #${car.ref ?? '?'} ${car.id} ${label}${changed}` +
          (status ? '' : ` (${failure ?? 'inconclusive'})`),
      );
      if (queue.length && !abandoned) await sleep(jittered(options.delayMs));
    }
  } finally {
    await page.close();
  }
}

await Promise.all(Array.from({ length: workerCount }, worker));

// Keep the index in step: the scraper reads `unavailable` to skip dead
// listings, and the viewer reads the per-car field to grey them out.
if (existsSync(INDEX_FILE)) {
  const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
  const unavailable = index.unavailable ?? {};
  const byId = new Map(results.map((r) => [r.id, r]));

  for (const result of results) {
    if (result.status === 'sold') unavailable[result.id] ??= new Date().toISOString();
    if (result.status === 'available') delete unavailable[result.id];
  }

  writeFileSync(
    INDEX_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        unavailable,
        cars: (index.cars ?? []).map((car) => {
          const result = byId.get(car.id);
          return result?.status
            ? { ...car, availability: { status: result.status, checkedAt: new Date().toISOString() } }
            : car;
        }),
      },
      null,
      2,
    ),
  );
}

if (abandoned) {
  console.log(
    `\nStopped after ${BLOCK_LIMIT} bot-blocks in a row - mobile.de is refusing the ` +
      'whole run, not one listing. Leave it for a while and start again; ' +
      `${queue.length} listing(s) were left unchecked and nothing was overwritten.`,
  );
}

const sold = results.filter((r) => r.status === 'sold');
const gone = sold.filter((r) => r.was !== 'sold');
const back = results.filter((r) => r.status === 'available' && r.was === 'sold');
const unknown = results.filter((r) => !r.status);
const blocked = unknown.filter((r) => r.failure === 'bot-block');

console.log(
  `\n${results.length - sold.length - unknown.length} available, ${sold.length} sold, ` +
    `${unknown.length} inconclusive, ${skipped} skipped.`,
);
if (blocked.length) {
  console.log(
    `${blocked.length} of those were bot-blocked, not answered - re-run later, ` +
      'or raise --delay. Their stored status is unchanged.',
  );
}
for (const car of gone) console.log(`  newly sold: #${car.ref ?? '?'} ${car.id} ${car.title ?? ''}`);
for (const car of back) console.log(`  back on offer: #${car.ref ?? '?'} ${car.id}`);
