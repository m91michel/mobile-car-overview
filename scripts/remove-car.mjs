#!/usr/bin/env node
// Deliberately drop a car from the comparison.
//
//   pnpm remove-car -- 419188575
//   pnpm remove-car -- '#21'
//
// Note this is not the same as a car going off sale. A sold listing is *marked*
// by pnpm available, so the viewer can grey it out and keep the data it was
// scraped with. This command is for a car you have decided against, and it
// really does delete the file.
//
// The reference number is deliberately NOT released: numbers are never reused,
// so "#21" keeps pointing at the same car in any note or screenshot, and the
// gap in the sequence is the record that it was dropped.
//
// The name is `remove-car`, not `remove`: `pnpm remove` is a built-in that
// uninstalls dependencies.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_FILE = resolve('data/cars.json');
const REFS_FILE = resolve('data/refs.json');

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (!args.length) {
  console.error("Usage: pnpm remove-car -- <listing-id | '#ref'> [...]");
  process.exit(1);
}

const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
const refs = existsSync(REFS_FILE) ? JSON.parse(readFileSync(REFS_FILE, 'utf8')) : { refs: {} };

// Accept either a mobile.de id or the short reference number.
const resolveId = (arg) => {
  const wanted = arg.replace(/^#/, '');
  if (/^\d{6,}$/.test(wanted)) return wanted;
  const ref = Number(wanted);
  const hit = index.cars.find((car) => car.ref === ref);
  return hit?.id ?? null;
};

let removed = 0;
for (const arg of args) {
  const id = resolveId(arg);
  const car = id ? index.cars.find((c) => c.id === id) : null;
  if (!car) {
    console.error(`  ${arg}: not in the comparison - nothing removed.`);
    continue;
  }

  index.cars = index.cars.filter((c) => c.id !== id);
  const file = resolve('data/listings', `${id}.json`);
  if (existsSync(file)) unlinkSync(file);

  console.log(`  removed #${car.ref} ${car.title?.slice(0, 46) ?? id} (${id})`);
  console.log(`    reference #${car.ref} stays reserved and will not be reused.`);
  removed++;
}

if (removed) {
  index.updatedAt = new Date().toISOString();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n${removed} removed; ${index.cars.length} car(s) left.`);
} else {
  process.exit(1);
}
