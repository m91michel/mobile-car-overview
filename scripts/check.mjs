#!/usr/bin/env node
// Data quality report over the scraped cars.
//
//   pnpm check
//
// Two questions it answers:
//   1. Are any two saved cars actually the same vehicle listed twice?
//   2. Is anything in the normalized data going to render badly?

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_FILE = resolve('data/cars.json');
const OUT_DIR = resolve('data/listings');

function loadCars() {
  if (existsSync(INDEX_FILE)) {
    const cars = JSON.parse(readFileSync(INDEX_FILE, 'utf8')).cars ?? [];
    if (cars.length) return cars;
  }
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(OUT_DIR, f), 'utf8')));
}

const cars = loadCars();
if (!cars.length) {
  console.error('No cars found. Run pnpm saved or pnpm scrape first.');
  process.exit(1);
}

const fact = (car, tag) => car.facts?.[tag]?.value ?? null;
const label = (car) => `${car.id} ${car.shortTitle ?? ''} ${car.price?.localized ?? ''}`.trim();

console.log(`Checking ${cars.length} car(s).\n`);

// --- duplicates -------------------------------------------------------------
// Ranked by how much they actually prove. A dealer reusing stock photography is
// common in a single dealer group, so image overlap alone proves nothing.
const findings = [];

const byDealerSku = new Map();
for (const car of cars) {
  if (!car.sku) continue;
  const key = `${car.dealer?.name ?? '?'}::${car.sku}`;
  (byDealerSku.get(key) ?? byDealerSku.set(key, []).get(key)).push(car);
}
for (const [key, group] of byDealerSku) {
  if (group.length > 1) {
    findings.push({
      confidence: 'duplicate',
      reason: `same dealer and Fahrzeugnummer (${key.split('::')[1]})`,
      cars: group,
    });
  }
}

// A physical car is pinned down well by these together.
const bySpec = new Map();
for (const car of cars) {
  const key = [
    car.make,
    car.model,
    car.derived?.mileageKm,
    car.derived?.firstRegistration,
    car.derived?.powerKw,
    fact(car, 'manufacturerColorName')?.toLowerCase(),
    fact(car, 'fuel'),
  ].join('|');
  (bySpec.get(key) ?? bySpec.set(key, []).get(key)).push(car);
}
for (const group of bySpec.values()) {
  if (group.length > 1) {
    findings.push({
      confidence: 'duplicate',
      reason: 'identical make, model, mileage, first registration, power, colour and fuel',
      cars: group,
    });
  }
}

// Image overlap, discounting assets that show up across many listings (dealer
// banners, "BMW Premium Selection" badges and the like).
const imageFrequency = new Map();
for (const car of cars) {
  for (const uri of new Set(car.images ?? [])) {
    imageFrequency.set(uri, (imageFrequency.get(uri) ?? 0) + 1);
  }
}
const distinctive = new Map(
  cars.map((car) => [
    car.id,
    new Set((car.images ?? []).filter((uri) => imageFrequency.get(uri) <= 2)),
  ]),
);
const stockPhotos = [];
for (let i = 0; i < cars.length; i++) {
  for (let j = i + 1; j < cars.length; j++) {
    const shared = [...distinctive.get(cars[i].id)].filter((uri) =>
      distinctive.get(cars[j].id).has(uri),
    );
    if (!shared.length) continue;
    const sameCar =
      cars[i].derived?.mileageKm === cars[j].derived?.mileageKm &&
      cars[i].derived?.firstRegistration === cars[j].derived?.firstRegistration;
    if (sameCar) {
      findings.push({
        confidence: 'likely duplicate',
        reason: `${shared.length} shared photo(s) and identical mileage/first registration`,
        cars: [cars[i], cars[j]],
      });
    } else {
      stockPhotos.push([cars[i], cars[j], shared.length]);
    }
  }
}

console.log('== duplicates ==');
if (!findings.length) {
  console.log('  none found.');
} else {
  for (const finding of findings) {
    console.log(`  [${finding.confidence}] ${finding.reason}`);
    for (const car of finding.cars) console.log(`      ${label(car)}`);
  }
}
if (stockPhotos.length) {
  console.log(
    `\n  (${stockPhotos.length} pair(s) share photos but differ in mileage/registration -` +
      ' dealer stock photography, not duplicates.)',
  );
}

// --- normalization ----------------------------------------------------------
console.log('\n== normalization ==');
const total = cars.length;
const tagCount = new Map();
const tagLabel = new Map();
const multiValue = new Map();
let nbsp = 0;

for (const car of cars) {
  for (const [tag, entry] of Object.entries(car.facts ?? {})) {
    tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    tagLabel.set(tag, entry.label);
    if (entry.values) multiValue.set(tag, entry.values.length);
    if (/ /.test(entry.value) || / /.test(entry.label)) nbsp++;
  }
}

console.log(`  ${tagCount.size} distinct fact tags across ${total} car(s).`);
console.log(`  non-breaking spaces left in values: ${nbsp}`);

if (multiValue.size) {
  console.log('\n  multi-value fields (rendered as separate lines, not concatenated):');
  for (const [tag, count] of multiValue) {
    console.log(`    ${tag.padEnd(32)} ${count} values  ${tagLabel.get(tag)?.slice(0, 40) ?? ''}`);
  }
}

const rare = [...tagCount.entries()].filter(([, n]) => n <= Math.max(1, total * 0.2));
if (rare.length) {
  console.log('\n  rare fields (present on <=20% of cars - mostly empty rows in a comparison):');
  for (const [tag, n] of rare.sort((a, b) => a[1] - b[1])) {
    console.log(`    ${String(n).padStart(2)}/${total}  ${tag.padEnd(32)} ${tagLabel.get(tag) ?? ''}`);
  }
}

// Distinguish "the listing never had this field" from "we failed to parse it".
// Only the second kind is a bug worth chasing.
const DERIVED_SOURCE = {
  mileageKm: 'mileage',
  powerKw: 'power',
  powerHp: 'power',
  cubicCapacityCcm: 'cubicCapacity',
  firstRegistration: 'firstRegistration',
  constructionYear: 'constructionYear',
  seats: 'numSeats',
  previousOwners: 'numberOfPreviousOwners',
  weightKg: 'netWeight',
  fuelTankLitres: 'fuelTankVolume',
  co2GramsPerKm: 'envkv.co2Emissions',
  consumptionL100km: 'envkv.energyConsumption',
};

const unparseable = new Map();
const absent = new Map();
for (const car of cars) {
  for (const [key, value] of Object.entries(car.derived ?? {})) {
    if (value !== null) continue;
    const source = DERIVED_SOURCE[key];
    const target = source && fact(car, source) ? unparseable : absent;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
}

if (unparseable.size) {
  console.log('\n  PARSE FAILURES (field present but no number extracted):');
  for (const [key, n] of [...unparseable].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(2)}/${total}  ${key}  <- ${DERIVED_SOURCE[key]}`);
  }
} else {
  console.log('\n  no parse failures: every number the listings do provide was extracted.');
}

if (absent.size) {
  const summary = [...absent]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} (${n})`)
    .join(', ');
  console.log(`  absent at the source, nothing to parse: ${summary}`);
}
