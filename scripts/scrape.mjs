#!/usr/bin/env node
// Fetch mobile.de listings into normalized JSON.
//
//   pnpm scrape -- 462145366 459175992
//   pnpm scrape -- 'https://www.mobile.de/park/compare?id=1&id=2'
//   pnpm saved                      # everything bookmarked in Mein Parkplatz
//   pnpm refresh                    # re-fetch every car already in data/
//   pnpm scrape -- --from cars.txt
//
// Flags:
//   --saved             read ids from Mein Parkplatz (needs a signed-in profile)
//   --from <file>       newline-delimited urls/ids; blank lines and # ignored
//   --refresh           re-fetch every id already present in data/cars.json
//   --recheck-sold      also re-try listings previously found sold
//   --max-age <hours>   skip cars fetched more recently than this
//   --delay <ms>        pause between listings per worker (default 1200)
//   --retries <n>       retries per listing (default 2)
//   --concurrency <n>   parallel tabs (default 1; keep low to stay unremarkable)

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { ensureChrome, PORT } from './chrome.mjs';
import { openPage } from './cdp.mjs';
import { parseListingHtml, LISTING_READY_PROBE } from './extract.mjs';
import { readParkplatz } from './parkplatz.mjs';
import { loadRefs, saveRefs, assignRef } from './refs.mjs';
import { loadAssessments, applyAssessment } from './assessment.mjs';

const OUT_DIR = resolve('data/listings');
const INDEX_FILE = resolve('data/cars.json');
const DETAIL_URL = (id) =>
  `https://suchen.mobile.de/fahrzeuge/details.html?id=${id}&scopeId=C&action=compareItem`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const options = {
    inputs: [],
    saved: false,
    from: null,
    refresh: false,
    recheckSold: false,
    maxAgeHours: null,
    delayMs: 1200,
    retries: 2,
    concurrency: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    // pnpm forwards the `--` separator itself, unlike npm.
    if (arg === '--') continue;
    switch (arg) {
      case '--saved': options.saved = true; break;
      case '--refresh': options.refresh = true; break;
      case '--recheck-sold': options.recheckSold = true; break;
      case '--from': options.from = value(); break;
      case '--max-age': options.maxAgeHours = Number(value()); break;
      case '--delay': options.delayMs = Number(value()); break;
      case '--retries': options.retries = Number(value()); break;
      case '--concurrency': options.concurrency = Math.max(1, Number(value())); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        options.inputs.push(arg);
    }
  }
  return options;
}

/** Turn urls / ids / compare-urls into a flat list of listing ids. */
function collectIds(inputs) {
  const ids = [];
  for (const input of inputs) {
    if (/^\d{6,}$/.test(input)) {
      ids.push(input);
      continue;
    }
    let url;
    try {
      url = new URL(input);
    } catch {
      console.warn(`  ignoring unrecognised input: ${input}`);
      continue;
    }
    // Detail and compare URLs both carry their ids as `id` query params.
    const fromQuery = url.searchParams.getAll('id').filter((id) => /^\d{6,}$/.test(id));
    if (fromQuery.length) {
      ids.push(...fromQuery);
      continue;
    }
    const fromPath = url.pathname.match(/(\d{6,})\.html$/);
    if (fromPath) ids.push(fromPath[1]);
    else console.warn(`  found no listing id in: ${input}`);
  }
  return ids;
}

function readIndex() {
  const empty = { cars: [], unavailable: {} };
  if (!existsSync(INDEX_FILE)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    return { cars: parsed.cars ?? [], unavailable: parsed.unavailable ?? {} };
  } catch {
    console.warn('data/cars.json is unreadable; starting a fresh index.');
    return empty;
  }
}

function readIdFile(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return collectIds(lines);
}

/** Fetch one listing, with retries for slow renders and transient blocks. */
async function fetchListing(page, id, { retries, delayMs }) {
  const url = DETAIL_URL(id);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs * (attempt + 1)); // back off a little
    try {
      await page.goto(url);
      const status = await page.waitForStatus(LISTING_READY_PROBE, { timeoutMs: 20000 });

      if (status === 'unavailable') {
        // A definitive answer; retrying cannot help.
        throw Object.assign(new Error('no longer available (sold or withdrawn)'), {
          terminal: true,
        });
      }
      if (status === 'blocked') {
        lastError = new Error('bot-block page served');
        continue;
      }

      return parseListingHtml(await page.html(), url);
    } catch (error) {
      if (error.terminal) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('failed for unknown reasons');
}

// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
const { cars: index, unavailable } = readIndex();

let ids = collectIds(options.inputs);
if (options.from) ids.push(...readIdFile(options.from));
if (options.refresh) ids.push(...index.map((car) => car.id));

const { started } = await ensureChrome();
if (started) console.log('Started a Chrome window for scraping (leave it open).');

if (options.saved) {
  console.log('Reading Mein Parkplatz...');
  const page = await openPage(PORT);
  try {
    const parked = await readParkplatz(page);
    const stillListed = parked.comparable.length;
    console.log(
      `  found ${parked.ids.length} parked vehicle(s)` +
        (stillListed && stillListed < parked.ids.length
          ? ` (${stillListed} still offered for comparison; the rest are likely sold).`
          : '.'),
    );
    ids.push(...parked.ids);
  } catch (error) {
    // A missing login is an instruction, not a crash.
    console.error(`\n${error.message}\n`);
    await page.close();
    process.exit(1);
  } finally {
    await page.close();
  }
}

ids = [...new Set(ids)];

if (!ids.length) {
  console.error(
    'Nothing to fetch. Pass ids/urls, or use --saved, --refresh or --from <file>.',
  );
  process.exit(1);
}

// A car that was sold stays sold. Re-checking 20 dead listings on every run is
// most of the runtime on a long-lived Parkplatz, so skip them unless asked.
let soldSkipped = 0;
if (!options.recheckSold) {
  const before = ids.length;
  ids = ids.filter((id) => !unavailable[id]);
  soldSkipped = before - ids.length;
  if (soldSkipped) {
    console.log(
      `Skipping ${soldSkipped} car(s) known to be sold (--recheck-sold to try again).`,
    );
  }
}

// Skip anything fetched recently enough to still be trustworthy.
let skipped = 0;
if (options.maxAgeHours) {
  const cutoff = Date.now() - options.maxAgeHours * 3600_000;
  const fresh = new Map(index.map((car) => [car.id, Date.parse(car.fetchedAt ?? 0)]));
  const before = ids.length;
  ids = ids.filter((id) => !(fresh.get(id) >= cutoff));
  skipped = before - ids.length;
  if (skipped) console.log(`Skipping ${skipped} car(s) fetched in the last ${options.maxAgeHours}h.`);
}

if (!ids.length) {
  console.log('Everything is already up to date.');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

const refs = loadRefs();
const assessments = loadAssessments();

const workerCount = Math.min(options.concurrency, ids.length);
console.log(
  `Fetching ${ids.length} listing(s)` +
    (workerCount > 1 ? ` across ${workerCount} tabs...` : '...'),
);

const queue = [...ids];
const cars = [];
const failures = [];
let done = 0;

async function worker() {
  const page = await openPage(PORT, { newTab: workerCount > 1 });
  try {
    while (queue.length) {
      const id = queue.shift();
      try {
        const car = await fetchListing(page, id, options);
        car.ref = assignRef(refs, car.id);
        applyAssessment(assessments, car);
        writeFileSync(resolve(OUT_DIR, `${car.id}.json`), JSON.stringify(car, null, 2));
        cars.push(car);
        console.log(
          `  [${++done}/${ids.length}] #${car.ref} ${id} ${car.shortTitle} - ${car.price.localized ?? 'n/a'}`,
        );
      } catch (error) {
        if (/no longer available/.test(error.message)) unavailable[id] = new Date().toISOString();
        failures.push({ id, message: error.message });
        console.log(`  [${++done}/${ids.length}] ${id} FAILED (${error.message})`);
      }
      if (queue.length) await sleep(options.delayMs);
    }
  } finally {
    await page.close();
  }
}

await Promise.all(Array.from({ length: workerCount }, worker));

// Merge, so fetching one car never drops the rest of the comparison.
const merged = new Map(index.map((car) => [car.id, car]));
for (const car of cars) merged.set(car.id, car);

saveRefs(refs);

// A car we just fetched is plainly not sold any more.
for (const car of cars) delete unavailable[car.id];

writeFileSync(
  INDEX_FILE,
  JSON.stringify(
    { updatedAt: new Date().toISOString(), unavailable, cars: [...merged.values()] },
    null,
    2,
  ),
);

console.log(
  `\n${cars.length} fetched, ${failures.length} failed, ${skipped + soldSkipped} skipped.`,
);
console.log(`Index: data/cars.json (${merged.size} car(s) total)`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f.id}: ${f.message}`);
  // Sold cars are normal attrition in a long comparison, not a run failure.
  const hardFailures = failures.filter((f) => !/no longer available/.test(f.message));
  if (hardFailures.length) process.exit(1);
}
