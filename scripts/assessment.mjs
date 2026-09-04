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

// 15.000 km/Jahr is the standard German market assumption (leasing contracts,
// DAT valuation) rather than something derived from this specific 47-car set,
// so it stays meaningful as the set grows or skews toward one mileage band.
const DEFAULT_MILEAGE_ADJUSTMENT = { referenceKmPerYear: 15000, ratePerKm: 0.1 };

const EMPTY = { retrofitPrices: {}, mileageAdjustment: DEFAULT_MILEAGE_ADJUSTMENT, cars: {} };

export function loadAssessments() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      retrofitPrices: parsed.retrofitPrices ?? {},
      mileageAdjustment: parsed.mileageAdjustment ?? DEFAULT_MILEAGE_ADJUSTMENT,
      cars: parsed.cars ?? {},
    };
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
 * Which retrofits a car needs, read straight from the listing.
 *
 * Only parts a workshop can actually add belong here. ACC is deliberately not
 * among them: the requirements note that retrofitting it on a G21 is barely
 * economical, so a missing ACC is a permanent gap rather than a price to add
 * (the viewer shows those in "Nicht nachrüstbar").
 */
export function deriveRetrofit(car) {
  const needed = [];

  // Any kind counts -- fixed, detachable or swivelling.
  const hasTowBar = (car.features ?? []).some((f) => f.includes('Anhängerkupplung'));
  if (!hasTowBar) needed.push('ahk');

  // The camera is not a feature: mobile.de reports it inside the parkAssists
  // fact, as "Kamera" or "360°-Kamera".
  const parkAssists = car.facts?.parkAssists?.value ?? '';
  if (!/Kamera/i.test(parkAssists)) needed.push('camera');

  return needed;
}

/**
 * A newer, low-mileage car and an older, high-mileage one aren't comparable on
 * asking price alone, but "bonus for new" vs. "malus for old" is a false choice
 * — both are the same adjustment once there is a reference point. This anchors
 * on the mileage a car would have at its age under the standard assumption
 * (`referenceKmPerYear`) and prices the deviation from that at `ratePerKm`:
 * fewer km than expected lowers the effective price, more raises it, symmetric
 * around zero instead of an arbitrary direction.
 *
 * Returns null when there is nothing to anchor on (age or mileage missing).
 */
export function deriveMileageAdjustment(registry, car) {
  const { referenceKmPerYear, ratePerKm } = registry.mileageAdjustment ?? DEFAULT_MILEAGE_ADJUSTMENT;
  const mileageKm = car.derived?.mileageKm;
  const firstRegistration = car.derived?.firstRegistration;
  if (typeof mileageKm !== 'number' || !firstRegistration) return null;

  const [year, month] = firstRegistration.split('-').map(Number);
  if (!year || !month) return null;

  const regDate = new Date(Date.UTC(year, month - 1, 1));
  const now = new Date();
  const ageMonths =
    (now.getUTCFullYear() - regDate.getUTCFullYear()) * 12 + (now.getUTCMonth() - regDate.getUTCMonth());
  const ageYears = Math.max(ageMonths, 0) / 12;

  const expectedKm = Math.round(ageYears * referenceKmPerYear);
  const deviationKm = mileageKm - expectedKm;
  // Rounded to the nearest 10 €: the underlying age is only known to the
  // month, so a cent-precise adjustment would imply precision it doesn't have.
  const adjustment = Math.round((deviationKm * ratePerKm) / 10) * 10;

  return { expectedKm, deviationKm, adjustment };
}

/**
 * Attach `car.assessment` for a car the registry knows about, and strip a stale
 * one otherwise — an unassessed car should read as a gap in the viewer, not as
 * a car whose effective price happens to equal its asking price.
 */
export function applyAssessment(registry, car) {
  const entry = registry.cars?.[String(car.id)] ?? null;

  // Retrofit needs are computed from the listing, so a newly scraped car has an
  // effective price immediately and nobody has to remember to type one in. An
  // entry may still pin the list explicitly via `retrofit` when a judgement
  // beats the derivation.
  //
  // A rejected car is priced as-is: costing up a retrofit for a car that is out
  // anyway would only add noise to the comparison.
  const keys =
    entry?.retrofit ??
    (entry?.verdict === 'raus' ? [] : deriveRetrofit(car));

  const retrofit = keys.map((key) => {
    const price = registry.retrofitPrices?.[key];
    if (!price) throw new Error(`Car ${car.id}: unknown retrofit key "${key}".`);
    return { key, label: price.label, cost: price.cost };
  });

  // mobile.de's fact fields offer a fixed set of options, so a seller describing
  // a combination seat has to pick one of them - "Stoff" for a Stoff/Sensatec
  // seat, verified on the listing photos. Overriding keeps the listed value
  // visible next to the corrected one: this is a judgement, not a scrape.
  for (const [tag, corrected] of Object.entries(entry?.factOverrides ?? {})) {
    const fact = car.facts?.[tag];
    if (!fact) throw new Error(`Car ${car.id}: factOverrides names unknown tag "${tag}".`);
    fact.listedValue ??= fact.value;
    fact.value = corrected;
    fact.corrected = true;
  }

  // Same idea as factOverrides, but for deriveModel's facelift guess: the
  // listing data alone can leave a registration month genuinely undecidable
  // (see extract.mjs), and a human check (dealer confirmation, curved-display
  // photo, VIN decode) can settle it. `derived` is recomputed from scratch on
  // every scrape/renormalize, so there is no stale `...Listed` value to worry
  // about carrying forward.
  if (entry?.faceliftOverride) {
    const { facelift, basis } = entry.faceliftOverride;
    if (!['lci', 'pre-lci', 'unknown', 'other-generation'].includes(facelift)) {
      throw new Error(`Car ${car.id}: faceliftOverride.facelift has an invalid value "${facelift}".`);
    }
    if (car.derived) {
      car.derived.faceliftBasisListed = car.derived.faceliftBasis;
      car.derived.facelift = facelift;
      car.derived.faceliftBasis = basis ?? car.derived.faceliftBasis;
      car.derived.faceliftCorrected = true;
    }
  }

  const retrofitCost = retrofit.reduce((sum, item) => sum + item.cost, 0);
  const gross = car.price?.gross;

  // A rejected car is priced as-is for the same reason its retrofit list is
  // empty above: weighing the mileage of a car that is out anyway only adds
  // noise. This also keeps an old, low-mileage "raus" outlier from producing
  // an outsized bonus the linear km/year model was never meant to cover.
  const mileageAdjustment = entry?.verdict === 'raus' ? null : deriveMileageAdjustment(registry, car);

  car.assessment = {
    // Editorial, and only ever hand-written: a car without an entry keeps a null
    // verdict so it still reads as un-judged in the viewer, even though its
    // effective price is now filled in automatically.
    verdict: entry?.verdict ?? null,
    note: entry?.note ?? null,
    retrofit,
    retrofitCost,
    mileageAdjustment,
    // Rounded: a cent-precise effective price would imply precision the
    // retrofit and mileage estimates do not have.
    effectivePrice:
      typeof gross === 'number'
        ? Math.round(gross + retrofitCost + (mileageAdjustment?.adjustment ?? 0))
        : null,
  };
  return car;
}
