// Pulls the listing data out of a mobile.de detail page.
//
// The page is a Next.js App Router app: the server streams its React Server
// Component payload through `self.__next_f.push([1, "<chunk>"])` calls. Joining
// those chunks yields one big string that contains a complete `"listing":{...}`
// object -- every hard fact, every feature, the price rating, the dealer. That
// is a far better source than scraping the rendered DOM, which splits the same
// data across tabs and lazy sections.

import { distanceFromHomeKm } from './geo.mjs';

/** Concatenate the RSC flight chunks embedded in the page HTML. */
export function readFlightPayload(html) {
  const chunks = [];
  const pushCall = /self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/gs;
  for (const match of html.matchAll(pushCall)) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // A chunk we cannot decode is not worth failing the whole page over.
    }
  }
  return chunks.join('');
}

/** Walk forward from an opening brace to its match, ignoring braces in strings. */
function matchBraces(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** The raw `listing` object as mobile.de's own frontend receives it. */
export function findListingObject(flight) {
  const candidates = [];
  for (const match of flight.matchAll(/"listing":\{/g)) {
    const raw = matchBraces(flight, match.index + '"listing":'.length);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.attributes && parsed.price) candidates.push(parsed);
    } catch {
      // Partial/streamed duplicates are expected; keep looking.
    }
  }
  // The page emits the same listing more than once; the richest copy wins.
  return candidates.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] ?? null;
}


const NBSP = /\u00a0/g;
const clean = (text) => String(text).replace(NBSP, ' ').trim();

/** German-formatted number -> Number. "43.285" -> 43285, "6,8" -> 6.8 */
function toNumber(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/-?\d{1,3}(?:\.\d{3})+|-?\d+(?:,\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Sellers sometimes type a placeholder instead of leaving a field blank -- real
 * example: "-- g/km" for CO2. In a comparison table a placeholder is worse than
 * an absent value, because it looks like data, so treat these as missing.
 */
function isPlaceholder(value) {
  if (/\d/.test(value)) return false;
  return /^[-\u2013\u2014]{1,3}(?:\s|$)/.test(value) || /^(k\.?\s?a\.?|keine angabe|n\/a|unbekannt)$/i.test(value);
}

/**
 * Turn mobile.de's attribute list into a stable map keyed by tag.
 *
 * Two things need normalizing, both found in real listings:
 *  - `value` is sometimes an array. `envkv.co2Costs` carries a low/mid/high
 *    variant, and passing the array straight through makes consumers render it
 *    as one run-on string, so keep an explicit `values` array alongside a
 *    deliberately joined display string.
 *  - Values are littered with non-breaking spaces, which break both display and
 *    naive equality checks between two cars.
 */
export function normalizeFacts(attributes = []) {
  const facts = {};
  for (const attribute of attributes) {
    const raw = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
    const values = raw.map(clean).filter(Boolean).filter((value) => !isPlaceholder(value));
    if (!values.length) continue;

    facts[attribute.tag] = {
      label: clean(attribute.label),
      value: values.join(' \u00b7 '),
      ...(values.length > 1 ? { values } : {}),
      // envkv.* are consumption/cost disclosures only a few listings carry.
      // Tagging the group lets the viewer treat them as one hideable block.
      group: attribute.tag.startsWith('envkv.') ? 'envkv' : 'vehicle',
    };
  }
  return facts;
}

/** Numeric views of the facts worth sorting, diffing or charting on. */
export function deriveNumbers(facts, sellerLatLong = null) {
  const get = (tag) => facts[tag]?.value ?? null;
  const power = get('power') ?? '';
  const registration = (get('firstRegistration') ?? '').match(/(\d{2})\/(\d{4})/);

  return {
    mileageKm: toNumber(get('mileage')),
    powerKw: toNumber(power),
    powerHp: toNumber((power.match(/\((\d+)\s*PS\)/) ?? [])[1] ?? ''),
    cubicCapacityCcm: toNumber(get('cubicCapacity')),
    firstRegistration: registration ? `${registration[2]}-${registration[1]}` : null,
    constructionYear: toNumber(get('constructionYear')),
    seats: toNumber(get('numSeats')),
    previousOwners: toNumber(get('numberOfPreviousOwners')),
    weightKg: toNumber(get('netWeight')),
    fuelTankLitres: toNumber(get('fuelTankVolume')),
    co2GramsPerKm: toNumber(get('envkv.co2Emissions')),
    consumptionL100km: toNumber(get('envkv.energyConsumption')),
    // Straight-line km from HOME to the seller -- see geo.mjs. Null when the
    // listing carries no coordinates.
    distanceFromHomeKm: distanceFromHomeKm(sellerLatLong),
  };
}

/** Flatten the raw listing into the shape the compare viewer consumes. */
export function normalize(listing, sourceUrl) {
  const facts = normalizeFacts(listing.attributes);
  const contact = listing.contact ?? {};

  return {
    id: String(listing.id),
    url: listing.url ?? sourceUrl,
    sourceUrl,
    fetchedAt: new Date().toISOString(),

    title: listing.title,
    shortTitle: listing.shortTitle,
    subTitle: listing.subTitle,
    make: listing.makeKey,
    model: listing.modelKey,
    category: listing.category,
    sku: listing.sku,
    isNew: listing.isNew,
    kba: listing.kba ?? null,

    price: {
      gross: listing.price?.grs?.amount ?? null,
      net: listing.price?.nt?.amount ?? null,
      currency: listing.price?.grs?.currency ?? 'EUR',
      localized: listing.price?.grs?.localized ?? null,
      vatRate: listing.price?.vat ?? null,
      vatNote: listing.vat ?? null,
      type: listing.price?.type ?? null,
    },

    priceRating: listing.priceRating
      ? {
          rating: listing.priceRating.rating,
          label: listing.priceRating.ratingLabel,
          offset: listing.priceRating.vehiclePriceOffset,
          thresholds: listing.priceRating.thresholdLabels ?? [],
        }
      : null,

    // Keyed by mobile.de's own tag (mileage, power, transmission, ...) so the
    // viewer can lay out hard facts and features in a single table.
    facts,
    derived: deriveNumbers(facts, contact.latLong),
    features: (listing.features ?? []).map(clean),
    highlights: listing.highlights ?? [],

    // Stored without a size: the CDN takes `?rule=mo-240|mo-360|mo-1024|mo-1600`,
    // so the viewer picks the size it needs per slot.
    images: (listing.images ?? []).map((img) =>
      img.uri?.startsWith('http') ? img.uri : `https://${img.uri}`,
    ),

    dealer: {
      name: contact.name ?? null,
      type: contact.type ?? null,
      street: contact.address1 ?? null,
      city: contact.address2 ?? null,
      country: contact.country ?? null,
      phone: contact.phones?.find((p) => p.type === 'PHONE1')?.number ?? null,
      homepage: contact.homepageUrl ?? null,
      location: contact.latLong ?? null,
      openingHours: contact.openingHours ?? [],
      rating: contact.rating
        ? {
            score: contact.rating.score,
            count: contact.rating.totalCount,
            recommendationRate: contact.rating.recommendationRate,
          }
        : null,
    },

    financePlans: listing.financePlans ?? [],
  };
}

/** html -> normalized car, or throw with a reason a human can act on. */
export function parseListingHtml(html, sourceUrl) {
  if (html.includes('Zugriff verweigert')) {
    throw new Error('mobile.de served its bot-block page (Zugriff verweigert)');
  }

  const flight = readFlightPayload(html);
  if (!flight) throw new Error('No Next.js flight payload found - page layout may have changed');

  const listing = findListingObject(flight);
  if (listing) return normalize(listing, sourceUrl);

  // Only now interpret the "unavailable" wording. Live pages embed that phrase
  // in unrelated modules, so it is an explanation for a failed parse -- never a
  // reason to skip parsing. The <title> is the reliable signal.
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  if (title.includes('nicht verf\u00fcgbar')) {
    throw new Error('listing is no longer available (sold or withdrawn)');
  }

  throw new Error('Flight payload contained no parseable listing object');
}

/**
 * An in-page expression that reports whether a detail page is worth reading yet.
 * Returns 'ready' | 'unavailable' | 'blocked' | 'pending'. Polling this instead
 * of sleeping a fixed few seconds is what makes batch runs tolerable.
 */
export const LISTING_READY_PROBE = `(() => {
  try {
    if (document.title.includes('Zugriff verweigert')) return 'blocked';
    if (/nicht verf\\u00fcgbar/i.test(document.title)) return 'unavailable';
    const flight = (self.__next_f || [])
      .map((chunk) => (Array.isArray(chunk) ? chunk[1] : null))
      .filter((text) => typeof text === 'string')
      .join('');
    if (flight.includes('"attributes":[{') && flight.includes('"price":{')) return 'ready';
    return 'pending';
  } catch (error) {
    return 'pending';
  }
})()`;
