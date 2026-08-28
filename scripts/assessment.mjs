// Editorial layer on top of the scraped facts: what a car really costs once the
// missing must-haves are retrofitted, plus a one-line verdict.
//
// Two things it is deliberately NOT:
//   - not derived from the listing, so it cannot be recomputed and has to be
//     kept by hand in data/assessment.json
//   - not stored in data/listings/*.json, because pnpm scrape rebuilds those
//     from the payload and would drop it (same reason data/refs.json exists)
//
// Retrofit costs are referenced by key rather than written per car, so changing
// one price in `retrofitPrices` re-prices every car that needs that part.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const FILE = resolve('data/assessment.json');

const EMPTY = { retrofitPrices: {}, cars: {} };

export function loadAssessments() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return { retrofitPrices: parsed.retrofitPrices ?? {}, cars: parsed.cars ?? {} };
  } catch {
    // Hand-written notes are not reproducible, so never silently reset the file.
    throw new Error('data/assessment.json is corrupt - fix or delete it deliberately.');
  }
}

export function saveAssessments(registry) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(registry, null, 2));
}

/**
 * Attach `car.assessment` for a car the registry knows about, and strip a stale
 * one otherwise — an unassessed car should read as a gap in the viewer, not as
 * a car whose effective price happens to equal its asking price.
 */
export function applyAssessment(registry, car) {
  const entry = registry.cars?.[String(car.id)];
  if (!entry) {
    delete car.assessment;
    return car;
  }

  const retrofit = (entry.retrofit ?? []).map((key) => {
    const price = registry.retrofitPrices?.[key];
    if (!price) throw new Error(`Car ${car.id}: unknown retrofit key "${key}".`);
    return { key, label: price.label, cost: price.cost };
  });

  const retrofitCost = retrofit.reduce((sum, item) => sum + item.cost, 0);
  const gross = car.price?.gross;

  car.assessment = {
    verdict: entry.verdict ?? null,
    note: entry.note ?? null,
    retrofit,
    retrofitCost,
    // Rounded: a cent-precise effective price would imply precision the
    // retrofit estimates do not have.
    effectivePrice: typeof gross === 'number' ? Math.round(gross + retrofitCost) : null,
  };
  return car;
}
