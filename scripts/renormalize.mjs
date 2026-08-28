#!/usr/bin/env node
// Re-apply the current normalization to already-scraped JSON, in place.
//
//   pnpm renormalize
//
// The raw values survive in data/listings/*.json, so improving normalizeFacts()
// does not require re-fetching every car from mobile.de.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeFacts, deriveNumbers } from './extract.mjs';
import { loadRefs, saveRefs, assignRef } from './refs.mjs';
import { loadAssessments, applyAssessment } from './assessment.mjs';

const OUT_DIR = resolve('data/listings');
const INDEX_FILE = resolve('data/cars.json');

if (!existsSync(OUT_DIR)) {
  console.error('No data/listings yet - run pnpm saved or pnpm scrape first.');
  process.exit(1);
}

const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
const refs = loadRefs();
const assessments = loadAssessments();

// Number in the index's existing order first, so the sequence matches the order
// the cars were already listed in rather than the filesystem's.
if (existsSync(INDEX_FILE)) {
  for (const car of JSON.parse(readFileSync(INDEX_FILE, 'utf8')).cars ?? []) {
    assignRef(refs, car.id);
  }
}

const cars = [];
let changed = 0;

for (const file of files) {
  const path = resolve(OUT_DIR, file);
  const car = JSON.parse(readFileSync(path, 'utf8'));

  // Rebuild the attribute list the normalizer expects from the stored facts.
  const attributes = Object.entries(car.facts ?? {}).map(([tag, fact]) => ({
    tag,
    label: fact.label,
    // Prefer the untouched array when a previous run kept one, and the seller's
    // own wording over an assessment override - otherwise re-running this would
    // normalize the correction and lose the value the listing actually stated.
    value: fact.values ?? fact.listedValue ?? fact.value,
  }));

  const fingerprint = () =>
    JSON.stringify({
      facts: car.facts,
      derived: car.derived,
      ref: car.ref,
      assessment: car.assessment,
    });

  const before = fingerprint();
  car.facts = normalizeFacts(attributes);
  car.derived = deriveNumbers(car.facts, car.dealer?.location);
  car.ref = assignRef(refs, car.id);
  applyAssessment(assessments, car);
  const after = fingerprint();

  if (before !== after) {
    changed++;
    writeFileSync(path, JSON.stringify(car, null, 2));
  }
  cars.push(car);
}

// Keep the index in step, preserving whatever else it already tracks.
const index = existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, 'utf8')) : {};
const byId = new Map(cars.map((car) => [car.id, car]));
writeFileSync(
  INDEX_FILE,
  JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      unavailable: index.unavailable ?? {},
      cars: (index.cars ?? []).map((car) => byId.get(car.id) ?? car),
    },
    null,
    2,
  ),
);

saveRefs(refs);

console.log(`Renormalized ${files.length} file(s); ${changed} changed.`);
console.log(`Reference numbers: #1..#${refs.nextRef - 1} (gaps are sold cars).`);
