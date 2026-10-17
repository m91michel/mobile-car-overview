// Rows, cells and sorting for every collection that is not the cars: Kitas,
// Kinderwagen, whatever gets compared next. Those listings are written by hand
// (or by Claude), not scraped, so the input format is deliberately forgiving
// and `normalizeItem` turns it into the same shape the cars have. The table,
// the picker, the lists and the map then work on it unchanged.
//
// Smallest useful listing, data/<collection>/listings/<id>.json:
//
//   {
//     "id": "kita-sonnenschein",
//     "title": "Kita Sonnenschein",
//     "facts": { "Träger": "Stadt Fürth", "Plätze": 45 },
//     "features": ["Garten", "Bio-Essen"]
//   }
//
// Everything else is optional: url, subtitle, description, images[], price
// (a number, or {gross, localized}), priceUnit, location {name, street, city,
// lat, lon}. A fact is a plain value (the key is its label) or {label, value},
// optionally with links: [{label, url}] to show in the cell instead of the text.

import { STATUSES } from './rows.js';

/** Home, for the Luftlinie column. Same Fürth default as scripts/geo.mjs. */
export const HOME = { lat: 49.4772, lon: 10.9887, label: 'Fürth' };

const euro = (n) => `${n.toLocaleString('de-DE', { maximumFractionDigits: 2 })} €`;

/**
 * Great-circle km to the collection's home (collection.json `home`, else
 * Fürth), one decimal: across a city the whole kilometres would tie. The cars
 * get theirs baked in by scripts/geo.mjs.
 */
function distanceKm(lat, lon, home = HOME) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const a =
    Math.sin(rad(lat - home.lat) / 2) ** 2 +
    Math.cos(rad(home.lat)) * Math.cos(rad(lat)) * Math.sin(rad(lon - home.lon) / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
}

/** "1,2 km · 15 min" -> 1.2: the first number in a German-formatted text. */
export function leadingNumber(text) {
  const match = /-?\d[\d.]*(?:,\d+)?/.exec(String(text ?? ''));
  return match ? Number(match[0].replace(/\./g, '').replace(',', '.')) : null;
}

const factText = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'ja' : 'nein';
  if (typeof value === 'number') return value.toLocaleString('de-DE');
  if (Array.isArray(value)) return value.map(factText).filter(Boolean).join(', ') || null;
  return String(value);
};

/** Only http(s) links: a hand-written file must not smuggle in a javascript: URL. */
const linksOf = (links) =>
  (Array.isArray(links) ? links : [])
    .filter((link) => /^https?:\/\//.test(link?.url ?? ''))
    .map((link) => ({ label: link.label || link.url, url: link.url }));

function normalizeFacts(raw) {
  const facts = {};
  for (const [key, entry] of Object.entries(raw ?? {})) {
    const isObject = entry && typeof entry === 'object' && !Array.isArray(entry);
    const value = factText(isObject ? entry.value : entry);
    if (value === null) continue;
    const links = isObject ? linksOf(entry.links) : [];
    facts[key] = { label: (isObject && entry.label) || key, value, ...(links.length ? { links } : {}) };
  }
  return facts;
}

function normalizePrice(raw, unit) {
  if (typeof raw === 'number') {
    return { gross: raw, localized: unit ? `${euro(raw)} ${unit}` : euro(raw) };
  }
  if (raw && typeof raw === 'object') {
    const gross = typeof raw.gross === 'number' ? raw.gross : null;
    return { ...raw, gross, localized: raw.localized ?? (gross !== null ? euro(gross) : null) };
  }
  return null;
}

/**
 * A hand-written listing in the cars' shape. `location` becomes `dealer`,
 * because the picker, the search and the map all read the seller's place
 * from there.
 */
export function normalizeItem(raw, collection) {
  const facts = normalizeFacts(raw.facts);
  const loc = raw.location ?? null;
  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  const hasCoords = loc && Number.isFinite(lat) && Number.isFinite(lon);
  const dealer = loc
    ? {
        name: loc.name ?? null,
        street: loc.street ?? null,
        city: loc.city ?? null,
        location: hasCoords ? { lat, lon } : null,
      }
    : null;
  return {
    ...raw,
    id: String(raw.id),
    title: raw.title ?? String(raw.id),
    images: Array.isArray(raw.images) ? raw.images : [],
    features: Array.isArray(raw.features) ? raw.features.map(String) : [],
    price: normalizePrice(raw.price, raw.priceUnit),
    facts,
    dealer,
    derived: {
      ...raw.derived,
      distanceFromHomeKm: hasCoords ? distanceKm(lat, lon, collection?.home) : null,
    },
    // Free-text filters search this as well, so "Text enthält Bio" finds a
    // fact value too and not only a feature name (filters.js).
    searchText: [raw.subtitle, raw.description, ...Object.values(facts).map((f) => f.value)]
      .filter(Boolean)
      .join(' \n '),
  };
}

/** Sort options for a generic collection: name first, price if there is one. */
export const GENERIC_SORTS = [
  { key: 'name', label: 'Name', value: (item) => item.title?.toLowerCase() ?? null },
  { key: 'price', label: 'Preis', value: (item) => item.price?.gross ?? null },
  {
    key: 'distance',
    label: 'Luftlinie',
    value: (item) => item.derived?.distanceFromHomeKm ?? null,
  },
];

/**
 * collection.json's `sortFacts` turn facts into sort buttons, by the first
 * number in their text: "Fußweg" sorts "0,4 km · 5 min" by the 0,4.
 */
export const factSorts = (keys = []) =>
  keys.map((key) => ({
    key: `fact:${key}`,
    label: key,
    value: (item) => leadingNumber(item.facts?.[key]?.value),
  }));

/** "Offen" plus whatever collection.json names, or the cars' list as a fallback. */
export function statusesFor(meta) {
  if (!Array.isArray(meta.statuses)) return STATUSES;
  return [
    STATUSES[0],
    ...meta.statuses.map((status) =>
      typeof status === 'string'
        ? { key: status.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-'), label: status }
        : status,
    ),
  ];
}

/**
 * One flat table, the same idea as the cars' buildRows: the union of every
 * fact and every feature any item has, so a gap shows as a gap. Facts follow
 * collection.json's `factOrder` (keys or labels), then first appearance.
 */
export function buildGenericRows(items, collection) {
  const rows = [];
  const any = (pick) => items.some((item) => pick(item));

  if (any((item) => item.price)) {
    rows.push({
      key: 'price',
      label: collection.priceLabel ?? 'Preis',
      kind: 'fact',
      value: (item) => item.price?.localized ?? null,
    });
  }
  if (any((item) => item.subtitle)) {
    rows.push({ key: 'subtitle', label: 'Kurzinfo', kind: 'fact', value: (item) => item.subtitle ?? null });
  }

  rows.push({
    key: 'status',
    label: 'Status',
    kind: 'status',
    value: (item) =>
      collection.statuses.find((s) => s.key === (item.status ?? ''))?.label ?? item.status,
  });
  rows.push({
    key: 'notes:note',
    label: 'Notiz',
    kind: 'fact',
    value: (item) => item.notes?.note || null,
  });
  rows.push({
    key: 'notes:links',
    label: 'Links',
    kind: 'links',
    value: (item) => {
      const links = item.notes?.links ?? [];
      return links.length ? links.map((link) => `${link.label}: ${link.url}`).join('\n') : null;
    },
  });

  const labels = new Map();
  for (const item of items) {
    for (const [key, fact] of Object.entries(item.facts ?? {})) {
      if (!labels.has(key)) labels.set(key, fact.label || key);
    }
  }
  const preferred = collection.factOrder ?? [];
  const rank = (key) => {
    const i = preferred.findIndex((p) => p === key || p === labels.get(key));
    return i === -1 ? preferred.length : i;
  };
  // Array.prototype.sort is stable, so equal ranks keep first-appearance order.
  for (const key of [...labels.keys()].sort((a, b) => rank(a) - rank(b))) {
    rows.push({
      key: `fact:${key}`,
      label: labels.get(key),
      kind: 'fact',
      value: (item) => item.facts?.[key]?.value ?? null,
    });
  }

  if (any((item) => item.description)) {
    rows.push({
      key: 'description',
      label: 'Beschreibung',
      kind: 'fact',
      value: (item) => item.description ?? null,
    });
  }
  if (any((item) => item.dealer)) {
    rows.push({
      key: 'location',
      label: 'Adresse',
      kind: 'fact',
      value: (item) =>
        item.dealer
          ? [item.dealer.name !== item.title ? item.dealer.name : null, item.dealer.street, item.dealer.city]
              .filter(Boolean)
              .join(' · ')
          : null,
    });
  }
  if (any((item) => item.derived?.distanceFromHomeKm != null)) {
    rows.push({
      key: 'distance',
      label: collection.home?.label ? `Luftlinie zu ${collection.home.label}` : 'Entfernung (Luftlinie)',
      kind: 'fact',
      value: (item) =>
        item.derived?.distanceFromHomeKm != null
          ? `${item.derived.distanceFromHomeKm.toLocaleString('de-DE')} km`
          : null,
    });
  }

  const features = new Set();
  for (const item of items) for (const feature of item.features ?? []) features.add(feature);
  for (const feature of [...features].sort((a, b) => a.localeCompare(b, 'de'))) {
    rows.push({
      key: `feature:${feature}`,
      label: feature,
      kind: 'feature',
      value: (item) => (item.features?.includes(feature) ? '✓' : null),
    });
  }

  return rows;
}

/**
 * The cars' cellFor (wishlist.js) knows CAR-REQUIREMENTS.md; this one knows
 * only collection.json's `keyFeatures`, which get the loud ✅ and ❌.
 */
export function genericCellFor(row, item, collection) {
  const raw = row.value(item);
  if (row.kind === 'feature') {
    const wanted = collection.keyFeatures?.includes(row.label);
    if (raw) return { mark: wanted ? '✅' : '✓', text: '', tone: 'good' };
    return wanted ? { mark: '❌', text: '', tone: 'bad' } : { mark: '', text: '–', tone: 'empty' };
  }
  if (!raw) return { mark: '', text: '–', tone: 'empty' };
  // The text stays the row's value (CSV, "Nur Unterschiede"); the cell shows
  // the links, whose labels say the same thing.
  const links = row.key.startsWith('fact:') ? item.facts?.[row.key.slice(5)]?.links : null;
  if (links?.length) return { mark: '', text: '', tone: null, links };
  return { mark: '', text: raw, tone: null };
}
