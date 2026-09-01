// Short internal reference numbers for vehicles ("#7" instead of "462145366").
//
// Rules that make the number worth trusting:
//   - assigned once, on first sight, and never changed afterwards
//   - never reused, even after a car is sold and drops out of the comparison
//   - kept in its own file, so regenerating data/cars.json cannot lose them
//
// Gaps are therefore normal and expected: they are sold cars, not bugs.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { writeJsonAtomic } from './atomic.mjs';

const REFS_FILE = resolve('data/refs.json');

export function loadRefs() {
  if (!existsSync(REFS_FILE)) return { nextRef: 1, refs: {} };
  try {
    const parsed = JSON.parse(readFileSync(REFS_FILE, 'utf8'));
    return { nextRef: parsed.nextRef ?? 1, refs: parsed.refs ?? {} };
  } catch {
    // Losing this file would renumber every car, so never silently reset it.
    throw new Error(`data/refs.json is corrupt - fix or delete it deliberately.`);
  }
}

export function saveRefs(registry) {
  writeJsonAtomic(REFS_FILE, { nextRef: registry.nextRef, refs: registry.refs });
}

/** The car's existing number, or the next free one. */
export function assignRef(registry, id) {
  const key = String(id);
  if (registry.refs[key]) return registry.refs[key];
  registry.refs[key] = registry.nextRef++;
  return registry.refs[key];
}
