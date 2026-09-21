// Smart lists: a saved rule set evaluated live against every known car, so a
// newly scraped car matching "unter 30k" shows up on the next render instead
// of requiring someone to click "Aktualisieren". A plain list (`{name, ids}`)
// is still a valid entry in `lists` -- Favoriten and any pre-existing list
// keep working unchanged -- this only adds a second shape (`{name, rules}`).
//
// Kraftstoff/Abstandstempomat/Anhängerkupplung/Erstzulassung are their own
// rule types rather than four more things to type into "Text", because each
// needs its own comparison, not a substring:
//   - Kraftstoff/Fahrzeugzustand categorize their free-text fact value instead
//     of matching it as text, because "Hybrid (Benzin/Elektro)" contains the
//     substring "Benzin" -- categorizing first is what lets one rule mean
//     "nur Diesel" instead of two ("enthält Diesel" + "enthält nicht Hybrid").
//   - Abstandstempomat/Anhängerkupplung are presence checks (vorhanden/nicht
//     vorhanden), not a value to compare against.
//   - Erstzulassung takes a month/year ("09/2022"), not a plain number.
// "Text" stays as the generic fallback for anything not covered above, still
// a case-insensitive substring against the mobile.de wording directly (no
// translation table), so a filter's own name can say whatever its builder
// wants.

export const RULE_TYPES = [
  { type: 'price', label: 'Preis' },
  { type: 'mileage', label: 'Kilometerstand' },
  { type: 'registration', label: 'Erstzulassung' },
  { type: 'fuel', label: 'Kraftstoff' },
  { type: 'acc', label: 'Abstandstempomat' },
  { type: 'ahk', label: 'Anhängerkupplung' },
  { type: 'msport', label: 'M Sport' },
  { type: 'upholstery', label: 'Stoff' },
  { type: 'condition', label: 'Fahrzeugzustand' },
  { type: 'text', label: 'Text' },
];

const HAS_MISSING_TYPES = new Set(['acc', 'ahk', 'msport', 'upholstery']);

export const FUEL_OPTIONS = ['Diesel', 'Benzin', 'Hybrid'];

export const CONDITION_OPTIONS = ['Unfallfrei', 'Gebrauchtfahrzeug', 'Unfallschaden'];

export function emptyRule(type = 'price') {
  if (type === 'text') return { type, op: 'contains', value: '' };
  if (type === 'fuel') return { type, op: 'eq', value: FUEL_OPTIONS[0] };
  if (type === 'condition') return { type, op: 'eq', value: CONDITION_OPTIONS[0] };
  if (HAS_MISSING_TYPES.has(type)) return { type, op: 'has' };
  return { type, op: 'lt', value: '' }; // price, mileage, registration
}

function parseRegistration(str) {
  const match = /^(\d{1,2})\/(\d{4})$/.exec((str ?? '').trim());
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return year * 12 + month;
}

export function ruleIsValid(rule) {
  if (HAS_MISSING_TYPES.has(rule.type)) return true;
  if (rule.type === 'fuel') return FUEL_OPTIONS.includes(rule.value);
  if (rule.type === 'condition') return CONDITION_OPTIONS.includes(rule.value);
  if (rule.type === 'registration') return parseRegistration(rule.value) !== null;
  if (rule.type === 'text') return rule.value.trim() !== '';
  return rule.value !== '' && Number.isFinite(Number(rule.value));
}

/** Everything a text rule can search, case-folded once per car. */
function textHaystack(car) {
  return [car.title, car.shortTitle, car.subTitle, car.facts?.fuel?.value, ...(car.features ?? [])]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

/**
 * Coarse fuel-type bucket from mobile.de's free-text "Kraftstoffart", which
 * carries extras like ", E10-geeignet" or "(Benzin/Elektro)" -- hybrid is
 * checked first because that string contains the substring "Benzin" too.
 */
export function fuelCategory(value) {
  const v = (value ?? '').toLowerCase();
  if (v.includes('hybrid')) return 'Hybrid';
  if (v.includes('diesel')) return 'Diesel';
  if (v.includes('benzin')) return 'Benzin';
  if (v.includes('elektro')) return 'Elektro';
  return null;
}

/**
 * mobile.de's Fahrzeugzustand ("Gebrauchtfahrzeug[, Unfallfrei|, Reparierter
 * Unfallschaden]") has exactly three values in practice. Categorized here,
 * not just in wishlist.js's coloring, so the filter and the 🟢/🟡/🔴 marks in
 * the table can never disagree about which bucket a car falls into.
 */
export function conditionCategory(value) {
  const v = value ?? '';
  if (/unfallfrei/i.test(v)) return 'Unfallfrei';
  if (/unfallschaden/i.test(v)) return 'Unfallschaden';
  return v ? 'Gebrauchtfahrzeug' : null;
}

/** Any kind counts -- fixed, detachable or swivelling (same rule as deriveRetrofit). */
const hasTowBar = (car) => Boolean(car.features?.some((f) => f.includes('Anhängerkupplung')));

/**
 * mobile.de only offers a fixed set of upholstery checkboxes, so a seller with
 * an actual Stoff/Sensatec or Stoff/Alcantara combination seat ticks plain
 * "Stoff" -- the same limitation `factOverrides` corrects per car once
 * verified from the listing photos. This treats only the plain,
 * non-combination "Stoff" value as pure cloth; a combination, Alcantara,
 * Kunstleder, Teilleder or Vollleder all count as not-cloth.
 */
export const isPureCloth = (value) => {
  const v = (value ?? '').trim();
  return /^stoff\b/i.test(v) && !v.includes('/');
};

/**
 * mobile.de's own "Sportpaket" tag is sometimes left unticked even though
 * Sportfahrwerk and Sportsitze are both present -- true of every other car in
 * this set carrying that pairing except #461917102 (see wishlist.js), so the
 * combination counts as M Sport too. The dealer's free-text title is
 * deliberately not used as a signal: checked against all 56 listings, every
 * title that says "M Sport" already has Sportpaket in `features`, and titles
 * are also the place "Sport Line" (a different, non-M trim) shows up, which
 * must not match.
 */
export const hasMSport = (car) =>
  Boolean(
    car.features?.includes('Sportpaket') ||
      (car.features?.includes('Sportfahrwerk') && car.features?.includes('Sportsitze')),
  );

function matchesRule(car, rule) {
  if (rule.type === 'price') {
    const price = car.price?.gross;
    if (typeof price !== 'number') return false;
    return rule.op === 'gt' ? price > Number(rule.value) : price < Number(rule.value);
  }
  if (rule.type === 'mileage') {
    const km = car.derived?.mileageKm;
    if (typeof km !== 'number') return false;
    return rule.op === 'gt' ? km > Number(rule.value) : km < Number(rule.value);
  }
  if (rule.type === 'registration') {
    const ruleValue = parseRegistration(rule.value);
    const [year, month] = (car.derived?.firstRegistration ?? '').split('-').map(Number);
    if (ruleValue === null || !year || !month) return false;
    const carValue = year * 12 + month;
    return rule.op === 'gt' ? carValue > ruleValue : carValue < ruleValue;
  }
  if (rule.type === 'fuel') {
    const hit = fuelCategory(car.facts?.fuel?.value) === rule.value;
    return rule.op === 'ne' ? !hit : hit;
  }
  if (rule.type === 'condition') {
    const hit = conditionCategory(car.facts?.damageCondition?.value) === rule.value;
    return rule.op === 'ne' ? !hit : hit;
  }
  if (rule.type === 'acc') {
    const has = Boolean(car.features?.includes('Abstandstempomat'));
    return rule.op === 'missing' ? !has : has;
  }
  if (rule.type === 'ahk') {
    const has = hasTowBar(car);
    return rule.op === 'missing' ? !has : has;
  }
  if (rule.type === 'msport') {
    const has = hasMSport(car);
    return rule.op === 'missing' ? !has : has;
  }
  if (rule.type === 'upholstery') {
    const has = isPureCloth(car.facts?.interior?.value);
    return rule.op === 'missing' ? !has : has;
  }
  if (rule.type === 'text') {
    const hit = textHaystack(car).includes(rule.value.trim().toLowerCase());
    return rule.op === 'not-contains' ? !hit : hit;
  }
  return true;
}

/** All of a filter's rules AND together -- that is what makes them combinable. */
export function matchesFilter(car, rules) {
  return (rules ?? []).every((rule) => matchesRule(car, rule));
}

export function filteredIds(cars, rules) {
  return (cars ?? []).filter((car) => matchesFilter(car, rules)).map((car) => car.id);
}

const OP_LABEL = {
  lt: '<',
  gt: '>',
  contains: 'enthält',
  'not-contains': 'enthält nicht',
  eq: '=',
  ne: '≠',
};

function summarizeRule(rule) {
  if (rule.type === 'text') return `Text ${OP_LABEL[rule.op]} „${rule.value}“`;
  if (rule.type === 'fuel') return `Kraftstoff ${OP_LABEL[rule.op]} ${rule.value}`;
  if (rule.type === 'condition') return `Fahrzeugzustand ${OP_LABEL[rule.op]} ${rule.value}`;
  if (rule.type === 'acc') return rule.op === 'missing' ? 'ohne Abstandstempomat' : 'mit Abstandstempomat';
  if (rule.type === 'ahk') return rule.op === 'missing' ? 'ohne Anhängerkupplung' : 'mit Anhängerkupplung';
  if (rule.type === 'msport') return rule.op === 'missing' ? 'ohne M Sport' : 'mit M Sport';
  if (rule.type === 'upholstery') return rule.op === 'missing' ? 'kein Stoff' : 'Stoff';
  if (rule.type === 'registration') return `Erstzulassung ${rule.op === 'gt' ? 'nach' : 'vor'} ${rule.value}`;
  const unit = rule.type === 'price' ? '€' : 'km';
  return `${rule.type === 'price' ? 'Preis' : 'km'} ${OP_LABEL[rule.op]} ${Number(rule.value).toLocaleString('de-DE')} ${unit}`;
}

export function summarizeFilter(rules) {
  return (rules ?? []).map(summarizeRule).join(' · ');
}
