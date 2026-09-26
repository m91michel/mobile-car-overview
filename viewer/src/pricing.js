// The mileage/age and facelift adjustments to the effective price, computed
// client-side so they can be tuned per browser instead of only in
// data/assessment.json. Pure — no fs, no localStorage —
// so App.jsx can freely recompute it on every settings change.
//
// scripts/assessment.mjs computes the same mileage formula server-side and
// bakes it into data/cars.json; that stays the shared default the settings
// dialog starts from. Retrofit cost and verdict stay server-authored editorial
// data and are only ever read here, never recomputed.

import { fuelCategory, hasMSport } from './filters.js';

export const DEFAULT_PRICING = {
  mileageEnabled: true,
  // 15.000 km/Jahr is the standard German market assumption (leasing
  // contracts, DAT valuation), matching scripts/assessment.mjs's default.
  referenceKmPerYear: 15000,
  ratePerKm: 0.1,
  // Whether a missing AHK counts towards the Effektivpreis at all. Some
  // buyers don't want a tow bar and would rather compare on the asking price
  // for that part, so this only ever removes the "ahk" retrofit item
  // (scripts/assessment.mjs's deriveRetrofit) — it never adds one back that
  // the server didn't derive.
  ahkEnabled: true,
  lciMalusEnabled: true,
  // A starting guess, not a market-derived number: the 47-car set has only 3
  // pre-facelift cars once "raus" is excluded, too few to fit a reliable
  // premium from. €1.200 matches the weight of the other adjustments already
  // in this tool (camera retrofit is €1.200, AHK €1.600) — tune it in the
  // settings dialog once more pre-LCI cars are in the set.
  lciMalus: 1200,
  // Boni for what makes a car worth more at the same asking price. They lower
  // the Effektivpreis, the same direction a below-expectation mileage does.
  // Off by default, so switching one on is a deliberate judgement. The 330
  // amount is a starting guess; M Sport and Hybrid are left at 0 on purpose
  // until someone decides what they are worth.  A bonus of 0 does nothing.
  bonus330Enabled: false,
  bonus330: 2000,
  bonusMSportEnabled: false,
  bonusMSport: 0,
  bonusHybridEnabled: false,
  bonusHybrid: 0,
};

/**
 * Settings stored before a key existed lack it, so the stored object is always
 * read on top of the defaults rather than instead of them.
 */
export const withPricingDefaults = (stored) => ({ ...DEFAULT_PRICING, ...stored });

/** `model` is "318"/"320"/"330" on every listing; the title is the fallback. */
export const is330 = (car) => /^330/.test(car.model ?? '') || /\b330\s?[a-z]?\b/i.test(car.title ?? '');

/**
 * The fuel fact first, the title second: one 330e is listed as plain "Benzin"
 * (#61), but no petrol-only G21 carries an "e" after its number.
 */
export const isHybrid = (car) =>
  fuelCategory(car.facts?.fuel?.value) === 'Hybrid' || /\b3\d0\s?e\b/i.test(car.title ?? '');

/** Each applicable bonus as `{key, label, amount}`, amount positive. */
export function computeBonuses(car, settings) {
  const bonuses = [];
  if (settings.bonus330Enabled && is330(car)) {
    bonuses.push({ key: '330', label: '330er', amount: settings.bonus330 });
  }
  if (settings.bonusMSportEnabled && hasMSport(car)) {
    bonuses.push({ key: 'msport', label: 'M Sport', amount: settings.bonusMSport });
  }
  if (settings.bonusHybridEnabled && isHybrid(car)) {
    bonuses.push({ key: 'hybrid', label: 'Hybrid', amount: settings.bonusHybrid });
  }
  return bonuses.filter((bonus) => bonus.amount > 0);
}

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
  const bonuses = skip ? [] : computeBonuses(car, settings);
  const bonusTotal = bonuses.reduce((sum, bonus) => sum + bonus.amount, 0);

  // Only ever drops the server-derived "ahk" item, never adds one it didn't
  // derive — see the ahkEnabled comment on DEFAULT_PRICING. Checked against
  // `=== false`, not falsy, so a pricing object saved to localStorage before
  // this setting existed still defaults to enabled instead of silently
  // dropping AHK for everyone who already has settings stored.
  const ahkEnabled = settings.ahkEnabled !== false;
  const retrofit = ahkEnabled ? assessment.retrofit : assessment.retrofit.filter((item) => item.key !== 'ahk');
  const retrofitCost = ahkEnabled ? assessment.retrofitCost : retrofit.reduce((sum, item) => sum + item.cost, 0);

  return {
    ...car,
    assessment: {
      ...assessment,
      retrofit,
      retrofitCost,
      mileageAdjustment,
      lciMalus,
      bonuses,
      effectivePrice:
        typeof gross === 'number'
          ? Math.round(gross + retrofitCost + (mileageAdjustment?.adjustment ?? 0) + lciMalus - bonusTotal)
          : null,
    },
  };
}
