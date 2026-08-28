// Turns the scraped listings into one flat list of comparison rows.
// Flat on purpose: mobile.de splits hard facts and Ausstattung across tabs,
// which is exactly what makes its own compare page useless.

/** Facts worth seeing first; everything else keeps the order mobile.de used. */
const PREFERRED_FACTS = [
  'mileage',
  'firstRegistration',
  'power',
  'fuel',
  'transmission',
  'numberOfPreviousOwners',
  'damageCondition',
  'hu',
  'category',
  'modelRange',
  'trimLine',
  'cubicCapacity',
  'cylinder',
  'numSeats',
  'doorCount',
  'emissionClass',
  'color',
  'interior',
];

const factRank = (key) => {
  const i = PREFERRED_FACTS.indexOf(key);
  return i === -1 ? PREFERRED_FACTS.length : i;
};

const euro = (n) =>
  typeof n === 'number' ? `${n.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null;

export const carLabel = (car) => car.title || [car.make, car.model].filter(Boolean).join(' ') || car.id;

/** Enough to tell two "BMW 318" apart in the picker. */
export const carSubline = (car) =>
  [car.facts?.firstRegistration?.value, car.facts?.mileage?.value].filter(Boolean).join(' · ');

/**
 * Listing photos stay on mobile.de's CDN — nothing is downloaded here.
 * It sizes per `?rule=`; known values are mo-240, mo-360, mo-1024 and mo-1600.
 * The suffix strip keeps JSON written by an older fetcher working.
 */
export const photo = (url, rule = 'mo-360') =>
  url ? `${url.replace(/\$_\d+\.[A-Za-z]+$/, '')}?rule=${rule}` : null;

export function buildRows(cars) {
  const rows = [];

  rows.push({
    key: 'price',
    label: 'Preis',
    kind: 'fact',
    value: (car) => car.price?.localized ?? euro(car.price?.gross),
  });
  rows.push({
    key: 'price:net',
    label: 'Preis netto',
    kind: 'fact',
    value: (car) => euro(car.price?.net),
  });
  rows.push({
    key: 'price:rating',
    label: 'Preisbewertung',
    kind: 'fact',
    value: (car) => car.priceRating?.label,
  });

  // Union of every fact key any car has, so a missing figure shows as a gap
  // instead of shifting the row out from under the others.
  const factLabels = new Map();
  for (const car of cars) {
    for (const [key, fact] of Object.entries(car.facts ?? {})) {
      if (!factLabels.has(key)) factLabels.set(key, fact.label || key);
    }
  }
  const factKeys = [...factLabels.keys()].sort((a, b) => factRank(a) - factRank(b));
  for (const key of factKeys) {
    rows.push({
      key: `fact:${key}`,
      label: factLabels.get(key),
      kind: 'fact',
      value: (car) => car.facts?.[key]?.value,
    });
  }

  rows.push({
    key: 'dealer',
    label: 'Anbieter',
    kind: 'fact',
    value: (car) => (car.dealer ? [car.dealer.name, car.dealer.city].filter(Boolean).join(' · ') : null),
  });
  rows.push({
    key: 'dealer:rating',
    label: 'Anbieter-Bewertung',
    kind: 'fact',
    value: (car) =>
      car.dealer?.rating?.score ? `${car.dealer.rating.score} (${car.dealer.rating.count})` : null,
  });
  rows.push({
    key: 'fetchedAt',
    label: 'Daten von',
    kind: 'fact',
    value: (car) => (car.fetchedAt ? new Date(car.fetchedAt).toLocaleDateString('de-DE') : null),
  });

  const features = new Set();
  for (const car of cars) for (const feature of car.features ?? []) features.add(feature);
  for (const feature of [...features].sort((a, b) => a.localeCompare(b, 'de'))) {
    rows.push({
      key: `feature:${feature}`,
      label: feature,
      kind: 'feature',
      value: (car) => (car.features?.includes(feature) ? '✓' : null),
    });
  }

  return rows;
}

/** True when at least two of the shown cars disagree on this row. */
export function rowDiffers(row, cars) {
  const values = cars.map((car) => row.value(car) ?? '');
  return values.some((v) => v !== values[0]);
}
