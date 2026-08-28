// The mileage/age and facelift adjustments to the effective price, computed
// client-side so they can be tuned per browser instead of only in
// data/assessment.json. Pure and dependency-free — no fs, no localStorage —
// so App.jsx can freely recompute it on every settings change.
//
// scripts/assessment.mjs computes the same mileage formula server-side and
// bakes it into data/cars.json; that stays the shared default the settings
// dialog starts from. Retrofit cost and verdict stay server-authored editorial
// data and are only ever read here, never recomputed.

export const DEFAULT_PRICING = {
  mileageEnabled: true,
  // 15.000 km/Jahr is the standard German market assumption (leasing
  // contracts, DAT valuation), matching scripts/assessment.mjs's default.
  referenceKmPerYear: 15000,
  ratePerKm: 0.1,
  lciMalusEnabled: true,
  // A starting guess, not a market-derived number: the 47-car set has only 3
  // pre-facelift cars once "raus" is excluded, too few to fit a reliable
  // premium from. €1.200 matches the weight of the other adjustments already
  // in this tool (camera retrofit is €1.200, AHK €1.600) — tune it in the
  // settings dialog once more pre-LCI cars are in the set.
  lciMalus: 1200,
};

/**
 * Same anchor-on-expected-mileage formula as deriveMileageAdjustment in
 * scripts/assessment.mjs, parameterised by the live settings instead of
 * data/assessment.json. See AGENTS.md "Mileage/age adjustment" for the
 * reasoning: fewer km than expected for the car's age lowers the effective
 * price, more raises it, symmetric around zero.
 */
export function computeMileageAdjustment(car, settings) {
  if (!settings.mileageEnabled) return null;
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

  const expectedKm = Math.round(ageYears * settings.referenceKmPerYear);
  const deviationKm = mileageKm - expectedKm;
  const adjustment = Math.round((deviationKm * settings.ratePerKm) / 10) * 10;

  return { expectedKm, deviationKm, adjustment };
}

/**
 * Only applies to a car the facelift research (AGENTS.md "Facelift") actually
 * places pre-LCI — not to "unknown" (genuinely undecidable registration
 * months) or "other-generation" (not a G21 at all), where a malus would be a
 * guess rather than a judgement.
 */
export function computeLciMalus(car, settings) {
  if (!settings.lciMalusEnabled) return 0;
  return car.derived?.facelift === 'pre-lci' ? settings.lciMalus : 0;
}

/**
 * Re-derives `car.assessment` with the live pricing settings, leaving verdict,
 * note and retrofit (hand-edited in data/assessment.json) untouched.
 *
 * A "raus" car keeps the server's as-is price: the same reason its retrofit
 * list is skipped applies here — weighing an already-rejected car only adds
 * noise, and it keeps an old, low-mileage reject from an outsized bonus the
 * linear km/year model isn't meant to cover.
 */
export function applyPricingSettings(car, settings) {
  const assessment = car.assessment;
  if (!assessment) return car;

  const gross = car.price?.gross;
  const skip = assessment.verdict === 'raus';
  const mileageAdjustment = skip ? null : computeMileageAdjustment(car, settings);
  const lciMalus = skip ? 0 : computeLciMalus(car, settings);

  return {
    ...car,
    assessment: {
      ...assessment,
      mileageAdjustment,
      lciMalus,
      effectivePrice:
        typeof gross === 'number'
          ? Math.round(gross + assessment.retrofitCost + (mileageAdjustment?.adjustment ?? 0) + lciMalus)
          : null,
    },
  };
}
