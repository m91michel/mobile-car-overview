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
//   --delay <ms>        pause between listings per worker (default 2500, jittered)
//   --retries <n>       retries per listing (default 2)
//   --cooloff <ms>      first wait after a bot-block, grows per retry (default 60000)
//   --concurrency <n>   parallel tabs (default 1; keep low to stay unremarkable)
//   --via-park          reach each car by clicking its Parkplatz card, and
//                       linger on the page, instead of opening the detail URL
//                       cold. Falls back to direct navigation per car.
//   --limit <n>         stop cleanly after n cars, to spread a big refresh
//                       over several sittings rather than one long run
//
// On pacing: a 49-listing refresh at a flat 2.5s earned an Akamai block on the
// 41st page, and the three that followed were refused too. Volume is what gets
// noticed, not just the gap, so the delay is jittered (a metronome is exactly
// what a bot looks like) and the run gives up after a few blocks in a row
// rather than grinding through them - every retry while blocked digs the hole
// deeper. Whatever was fetched before that is still written, so an abandoned
// run resumes with --max-age instead of starting over.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { ensureChrome, PORT } from './chrome.mjs';
import { openPage } from './cdp.mjs';
import { parseListingHtml, LISTING_READY_PROBE } from './extract.mjs';
import { readParkplatz } from './parkplatz.mjs';
import { loadRefs, saveRefs, assignRef } from './refs.mjs';
import { loadAssessments, applyAssessment } from './assessment.mjs';
import { writeJsonAtomic } from './atomic.mjs';
import {
  ensureParkplatz, clickParkedCard, readListing, backToParkplatz, maybePause,
} from './human.mjs';

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
  const options = {
    inputs: [],
    saved: false,
    from: null,
    refresh: false,
    recheckSold: false,
    maxAgeHours: null,
    delayMs: 2500,
    retries: 2,
    cooloffMs: 60000,
    concurrency: 1,
    viaPark: false,
    limit: null,
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
      case '--cooloff': options.cooloffMs = Number(value()); break;
      case '--via-park': options.viaPark = true; break;
      case '--limit': options.limit = Math.max(1, Number(value())); break;
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

/**
 * Put the browser on the detail page for `id`.
 *
 * With --via-park this is a real click on the parked card, which is what a
 * person does. It falls back to navigating the URL whenever that is not
 * possible - the card is missing because the car sold, or the click did not
 * take - so the human path can never turn a fetchable car into a failure.
 *
 * @returns {Promise<string>} the URL the listing was actually read from
 */
async function reachListing(page, id, { viaPark }) {
  if (viaPark) {
    try {
      await ensureParkplatz(page);
      const clicked = await clickParkedCard(page, id);
      if (clicked) {
        const arrived = await page.waitForStatus(
          `location.href.includes('${id}') ? 'ready' : 'pending'`,
          { timeoutMs: 8000 },
        );
        if (arrived === 'ready') return await page.evaluate('location.href');
      }
      console.log(
        clicked
          ? `        the click on ${id} did not navigate, opening it directly`
          : `        no parked card for ${id} (sold?), opening it directly`,
      );
    } catch (error) {
      if (error.blocked) throw error;
      console.log(`        park route failed (${error.message}), opening directly`);
    }
  }
  await page.goto(DETAIL_URL(id));
  return DETAIL_URL(id);
}

/** Fetch one listing, with retries for slow renders and transient blocks. */
async function fetchListing(page, id, { retries, delayMs, cooloffMs, viaPark }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(jittered(delayMs) * (attempt + 1)); // back off a little
    try {
      const url = await reachListing(page, id, { viaPark });
      const status = await page.waitForStatus(LISTING_READY_PROBE, { timeoutMs: 20000 });

      if (status === 'unavailable') {
        // A definitive answer; retrying cannot help.
        throw Object.assign(new Error('no longer available (sold or withdrawn)'), {
          terminal: true,
        });
      }
      if (status === 'blocked') {
        // A block says nothing about this listing, so it must not be recorded
        // as one. Sit out a real cooloff -- the ordinary backoff is far too
        // short to outlast an Akamai refusal -- and flag it for the caller,
        // which counts blocks across listings and abandons the run.
        lastError = Object.assign(new Error('bot-block page served'), { blocked: true });
        if (attempt < retries) {
          const wait = cooloffMs * (attempt + 1);
          console.log(`        bot-block, waiting ${Math.round(wait / 1000)}s before retry`);
          await sleep(wait);
        }
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
// --limit stops a run early on purpose, which is not the same as being
// refused, so it gets its own flag and its own closing message.
let reachedLimit = false;

// Merge, so fetching one car never drops the rest of the comparison. Built
// before the workers start, because each car is now saved as it lands.
const merged = new Map(index.map((car) => [car.id, car]));

/**
 * Save everything the run has learned so far.
 *
 * Called after every car rather than once at the end, so cancelling a run
 * keeps its work: a blocked or simply long refresh can be stopped at any
 * point and the index, the ref registry and the sold list all agree with the
 * listing files on disk. Doing this only at the end meant a Ctrl-C left
 * data/listings/*.json updated while data/cars.json still showed old prices,
 * which needed a pnpm renormalize to repair.
 *
 * All three writes are atomic, since interrupting one is now likely rather
 * than theoretical.
 */
function persist() {
  writeJsonAtomic(INDEX_FILE, {
    updatedAt: new Date().toISOString(),
    unavailable,
    cars: [...merged.values()],
  });
  saveRefs(refs);
}

async function worker() {
  const page = await openPage(PORT, { newTab: workerCount > 1 });
  try {
    while (queue.length && !abandoned && !reachedLimit) {
      const id = queue.shift();
      try {
        const car = await fetchListing(page, id, options);
        car.ref = assignRef(refs, car.id);
        applyAssessment(assessments, car);
        writeJsonAtomic(resolve(OUT_DIR, `${car.id}.json`), car);
        cars.push(car);
        merged.set(car.id, car);
        // A car we just fetched is plainly not sold any more.
        delete unavailable[car.id];
        consecutiveBlocks = 0;
        persist();
        console.log(
          `  [${++done}/${ids.length}] #${car.ref} ${id} ${car.shortTitle} - ${car.price.localized ?? 'n/a'}`,
        );
        if (options.limit && cars.length >= options.limit) reachedLimit = true;
        // The payload is already parsed, so this only changes the shape of the
        // session: time on the page, then back to the list.
        if (options.viaPark && !reachedLimit) {
          await readListing(page);
          await backToParkplatz(page);
        }
      } catch (error) {
        if (/no longer available/.test(error.message)) {
          unavailable[id] = new Date().toISOString();
          persist();
        }
        // A blocked listing is not a failed listing: put it back so a later
        // run retries it, and stop once the whole run is plainly being refused.
        if (error.blocked) {
          queue.push(id);
          if (++consecutiveBlocks >= BLOCK_LIMIT) abandoned = true;
          console.log(`  [${done}/${ids.length}] ${id} blocked - will retry in a later run`);
          continue;
        }
        failures.push({ id, message: error.message });
        console.log(`  [${++done}/${ids.length}] ${id} FAILED (${error.message})`);
      }
      if (queue.length && !abandoned && !reachedLimit) {
        await sleep(jittered(options.delayMs));
        if (options.viaPark) await maybePause();
      }
    }
  } finally {
    await page.close();
  }
}

await Promise.all(Array.from({ length: workerCount }, worker));

// Everything is already on disk, saved per car. This last write only refreshes
// updatedAt for a run that fetched nothing.
persist();

console.log(
  `\n${cars.length} fetched, ${failures.length} failed, ${skipped + soldSkipped} skipped.`,
);
console.log(`Index: data/cars.json (${merged.size} car(s) total)`);

if (reachedLimit) {
  console.log(
    `\nStopped at the --limit of ${options.limit} car(s) as asked; ` +
      `${queue.length} still to go. Everything fetched is saved, so the next ` +
      'run picks up where this one stopped (add --max-age to skip these).',
  );
}

if (abandoned) {
  console.log(
    `\nStopped after ${BLOCK_LIMIT} bot-blocks in a row - mobile.de is refusing the ` +
      'whole run, not one listing. Leave it an hour and run again; the ' +
      `${queue.length} listing(s) left over kept their previous data, and ` +
      '--max-age skips what this run already got.',
  );
}

if (failures.length) {
  for (const f of failures) console.log(`  ${f.id}: ${f.message}`);
  // Sold cars are normal attrition in a long comparison, not a run failure.
  const hardFailures = failures.filter((f) => !/no longer available/.test(f.message));
  if (hardFailures.length) process.exit(1);
}
