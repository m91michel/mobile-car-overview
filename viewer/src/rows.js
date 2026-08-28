import { permanentGaps } from './wishlist.js';

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

// Short internal reference ("#7"), stable for the life of the car and far easier
// to quote than a 9-digit mobile.de id.
export const carRef = (car) => (typeof car.ref === 'number' ? `#${car.ref}` : '');

// The name only; the reference is rendered as its own badge next to it.
export const carLabel = (car) =>
  car.title || [car.make, car.model].filter(Boolean).join(' ') || car.id;

const numberFrom = (text) => {
  const digits = typeof text === 'string' ? text.replace(/\D/g, '') : '';
  return digits ? Number(digits) : null;
};

/** Sort options offered for the car list and, with it, the table columns. */
export const SORTS = [
  { key: 'ref', label: '#', value: (car) => (typeof car.ref === 'number' ? car.ref : null) },
  { key: 'price', label: 'Preis', value: (car) => car.price?.gross ?? null },
  {
    key: 'effectivePrice',
    label: 'Effektivpreis',
    value: (car) => car.assessment?.effectivePrice ?? null,
  },
  { key: 'mileage', label: 'km', value: (car) => numberFrom(car.facts?.mileage?.value) },
];

/** Cars without the sorted-on value go last, in both directions. */
export function sortCars(cars, sortKey, desc = false) {
  const pick = (SORTS.find((s) => s.key === sortKey) ?? SORTS[0]).value;
  return [...cars].sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return desc ? right - left : left - right;
  });
}

/** Set by pnpm available. A sold car is kept and greyed out, not dropped. */
export const isSold = (car) => car.availability?.status === 'sold';

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

  // Hand-kept assessment from data/assessment.json. The effective price is what
  // the car costs once the missing must-haves are retrofitted, which is the only
  // number two cars with different factory equipment can be compared on.
  rows.push({
    key: 'assessment:effectivePrice',
    label: 'Effektivpreis',
    kind: 'fact',
    value: (car) => euro(car.assessment?.effectivePrice),
  });
  rows.push({
    key: 'assessment:retrofit',
    label: 'Nachrüstung',
    kind: 'fact',
    value: (car) => {
      const retrofit = car.assessment?.retrofit;
      if (!retrofit?.length) return null;
      return retrofit.map((item) => `${item.label} ${euro(item.cost)}`).join(' + ');
    },
  });
  // Must sit next to Nachrüstung: that row only prices what a workshop can add,
  // so without this one a car with nothing retrofittable looks complete.
  rows.push({
    key: 'assessment:gaps',
    label: 'Nicht nachrüstbar',
    kind: 'fact',
    value: (car) => {
      const gaps = permanentGaps(car);
      return gaps.length ? gaps.join(', ') : null;
    },
  });
  rows.push({
    key: 'assessment:note',
    label: 'Bewertung',
    kind: 'fact',
    value: (car) => car.assessment?.note,
  });

  // Your own notes from data/notes.json, kept apart from the assessment above:
  // that one is a verdict on the car, this is whatever you want to remember.
  rows.push({
    key: 'notes:note',
    label: 'Notiz',
    kind: 'fact',
    value: (car) => car.notes?.note || null,
  });
  rows.push({
    key: 'notes:links',
    label: 'Links',
    kind: 'links',
    // A flat string as well, so the CSV export and the differences filter keep
    // working without knowing about links.
    value: (car) => {
      const links = car.notes?.links ?? [];
      return links.length ? links.map((link) => `${link.label}: ${link.url}`).join('\n') : null;
    },
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
      // A corrected fact keeps the seller's own wording alongside it, so the
      // table never hides that the value is a judgement rather than scraped.
      value: (car) => {
        const fact = car.facts?.[key];
        if (!fact) return null;
        return fact.corrected && fact.listedValue
          ? `${fact.value} (laut Inserat: ${fact.listedValue})`
          : fact.value;
      },
    });
  }

  rows.push({
    key: 'model:facelift',
    label: 'Modellpflege',
    kind: 'fact',
    value: (car) => {
      const labels = {
        lci: 'LCI (Facelift)',
        'pre-lci': 'vor Facelift',
        unknown: 'unklar (Umstellung 2022)',
        'other-generation': `andere Generation (${car.derived?.generation ?? '?'})`,
      };
      return labels[car.derived?.facelift] ?? null;
    },
  });
  rows.push({
    key: 'dealer',
    label: 'Anbieter',
    kind: 'fact',
    value: (car) => (car.dealer ? [car.dealer.name, car.dealer.city].filter(Boolean).join(' · ') : null),
  });
  rows.push({
    key: 'dealer:distance',
    label: 'Entfernung (Luftlinie)',
    kind: 'fact',
    value: (car) =>
      car.derived?.distanceFromHomeKm != null ? `${car.derived.distanceFromHomeKm} km` : null,
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

/**
 * The visible comparison as CSV — same cars, same rows, same order as on
 * screen. Features become ja/nein rather than the table's ✓, since the file
 * is meant to be read by something other than a person.
 */
export function toCsv(rows, cars) {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['Merkmal', ...cars.map((car) => `${carRef(car)} ${carLabel(car)}`.trim())];
  const body = rows.map((row) => [
    row.label,
    ...cars.map((car) => {
      const value = row.value(car);
      return row.kind === 'feature' ? (value ? 'ja' : 'nein') : (value ?? '');
    }),
  ]);
  // Leading BOM so Excel reads the umlauts; invisible to everything else.
  return `\ufeff${[header, ...body].map((line) => line.map(cell).join(',')).join('\r\n')}`;
}
