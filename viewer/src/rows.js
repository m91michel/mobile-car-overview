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

/** "DE-57076 Siegen" -> "Siegen"; the postcode only matters to the search. */
export const carCity = (car) => car.dealer?.city?.replace(/^[A-Z]{2}-\d+\s*/, '') || null;

/** Where the car stands, for the picker: city, distance, dealer. */
export const carPlace = (car) => {
  const km = car.derived?.distanceFromHomeKm;
  return [carCity(car), typeof km === 'number' ? `${km} km` : null, car.dealer?.name]
    .filter(Boolean)
    .join(' · ');
};

/**
 * Picker search: every whitespace-separated term must match. "#7" means ref 7
 * exactly (not #72); anything else is a substring of ref, id, title, dealer,
 * address or postcode.
 */
export function matchesSearch(car, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    carRef(car),
    car.id,
    car.title,
    car.make,
    car.model,
    car.dealer?.name,
    car.dealer?.city,
    car.dealer?.street,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((term) =>
    /^#\d+$/.test(term) ? carRef(car) === term : haystack.includes(term),
  );
}

/**
 * Listing photos stay on mobile.de's CDN — nothing is downloaded here.
 * It sizes per `?rule=`; known values are mo-240, mo-360, mo-1024 and mo-1600.
 * The suffix strip keeps JSON written by an older fetcher working.
 * Dealer-site photos (pnpm dealer) come from pixel-base, which sizes by
 * `&w=<px>` instead, so the same rule is translated to its width.
 */
export const photo = (url, rule = 'mo-360') => {
  if (!url) return null;
  if (url.includes('pixel-base.de')) {
    // Width alone is unreliable: one dealer's uploads come back as a blank
    // white frame (#73), another's ignore it and serve the full image. Width
    // plus height resizes both; 4:3 matches the source photos.
    const w = Number(rule.replace('mo-', ''));
    return `${url}&w=${w}&h=${Math.round((w * 3) / 4)}`;
  }
  return `${url.replace(/\$_\d+\.[A-Za-z]+$/, '')}?rule=${rule}`;
};

/** Where a car stands in the process. Nothing stored yet means "Offen". */
export const STATUSES = [
  { key: '', label: 'Offen' },
  { key: 'to-contact', label: 'Anschreiben' },
  { key: 'contacted', label: 'Angeschrieben' },
  { key: 'waiting', label: 'Warten' },
  { key: 'replied', label: 'Rückmeldung' },
  { key: 'appointment', label: 'Termin vereinbart' },
  { key: 'viewed', label: 'Besichtigt' },
  { key: 'declined', label: 'Abgesagt' },
  // Hand-set, and deliberately its own key: `isSold` above reads the scraped
  // availability, this one says you found out yourself.
  { key: 'sold', label: 'Verkauft' },
];

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

  // Hand-kept assessment from data/assessment.json plus the live pricing
  // settings (viewer/src/pricing.js). The effective price is what the car
  // costs once the missing must-haves are retrofitted and the mileage/facelift
  // adjustments are applied — the only number two differently equipped, aged
  // cars can be compared on. What makes it up (retrofit items, km vs. age,
  // facelift malus) sits in a hover hint on the cell rather than its own row —
  // see effectivePriceBreakdown in wishlist.js — so the table stays one row
  // per number instead of three mostly-empty ones.
  rows.push({
    key: 'assessment:effectivePrice',
    label: 'Effektivpreis',
    kind: 'fact',
    value: (car) => euro(car.assessment?.effectivePrice),
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

  rows.push({
    key: 'status',
    label: 'Status',
    kind: 'status',
    // Never null: every car has a status, and an untouched one is open.
    value: (car) => STATUSES.find((s) => s.key === (car.status ?? ''))?.label ?? car.status,
  });

  // Your own notes, kept apart from the assessment above:
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

  // Swivelling or fixed is a detail of one wish, not two of them, so the two
  // listing flags collapse into a single row that says which kind it is.
  const TOWBAR = ['Anhängerkupplung schwenkbar', 'Anhängerkupplung fest'];
  const names = [...features].filter((name) => !TOWBAR.includes(name));
  if (TOWBAR.some((name) => features.has(name))) names.push('Anhängerkupplung');

  for (const feature of names.sort((a, b) => a.localeCompare(b, 'de'))) {
    if (feature === 'Anhängerkupplung') {
      rows.push({
        key: 'wish:towbar',
        label: 'Anhängerkupplung',
        kind: 'wish',
        value: (car) => {
          const own = car.features ?? [];
          if (own.includes(TOWBAR[0])) return 'Schwenkbar';
          if (own.includes(TOWBAR[1])) return 'Fest';
          return null;
        },
      });
      continue;
    }
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
