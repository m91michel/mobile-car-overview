// The machine-readable half of CAR-REQUIREMENTS.md. That file is prose for a
// human; this is what the table colours by. Keep the two in step.

/**
 * "Ausstattung – hohe Priorität". These get the loud ✅ and ❌ — a missing ACC
 * has to be as visible as a present one, since that is the recurring reason a
 * car drops out.
 */
const KEY_FEATURES = new Set([
  'Abstandstempomat', // ACC, kaum wirtschaftlich nachrüstbar
  'Anhängerkupplung schwenkbar',
  'Anhängerkupplung fest',
  'Apple CarPlay',
]);

/**
 * Paint names map to a colour family, not to the exact factory paint: BMW's
 * "Portimao Blau" and "Phytonicblau" both show the same blue chip. The swatch
 * is there to make the row scannable, not to match a paint code.
 * Black before blue, so "Black Saphir" does not read as sapphire blue.
 */
const FAMILIES = [
  [/schwarz|black/i, 'schwarz', '#0c0d10'], // darker than the dark panel, or it reads as an empty chip
  [/wei(ß|ss)|white|alpin/i, 'weiß', '#eef0f2'],
  [/grau|gray|grey|graphit/i, 'grau', '#8b9096'],
  [/silber|silver/i, 'silber', '#c3c8cd'],
  [/blau|blue/i, 'blau', '#2a5db0'],
  [/rot|red/i, 'rot', '#b32b23'],
  [/grün|gruen|green/i, 'grün', '#2f7d4f'],
  [/braun|brown/i, 'braun', '#6d4a30'],
  [/beige/i, 'beige', '#d9caa9'],
  [/gold/i, 'gold', '#c8a13a'],
  [/bronze/i, 'bronze', '#a9762f'],
  [/orange/i, 'orange', '#e08420'],
  [/gelb|yellow/i, 'gelb', '#e3c018'],
  [/violett|lila|purple/i, 'violett', '#6d43a8'],
];

const familyOf = (value) => FAMILIES.find(([pattern]) => pattern.test(value));

/** Blau, Grau und Schwarz sind gewünscht; Weiß ist raus. Rest: neutral. */
const paint = (value) => {
  const name = familyOf(value)?.[1];
  if (name === 'weiß') return 'bad';
  if (name === 'blau' || name === 'grau' || name === 'schwarz') return 'good';
  return null;
};

const swatchFor = (value) => {
  const family = familyOf(value);
  if (!family) return null;
  return { color: family[2], metallic: /metallic|met\.|perl/i.test(value) };
};

/**
 * Judgements on hard facts. The camera lives in mobile.de's parkAssists field
 * rather than in features, so "Rückfahrkamera gewünscht" is decided here.
 */
const FACT_RULES = {
  parkAssists: (value) => (/kamera/i.test(value) ? 'good' : 'bad'),
  // "Benziner" is one of the non-negotiables; Diesel is an outright no.
  fuel: (value) => (/diesel/i.test(value) ? 'bad' : /benzin/i.test(value) ? 'good' : null),
  color: paint,
  manufacturerColorName: paint,
  // Leder, Alcantara, Sensatec und Teilleder sind ok, reine Stoffsitze nicht.
  // Sensatec heißt bei mobile.de Kunstleder, "Stoff/Sensatec" zählt als ok —
  // deshalb wird auf die guten Materialien vor "Stoff" geprüft.
  interior: (value) => {
    if (/leder|alcantara|sensatec/i.test(value)) return 'good';
    if (/stoff/i.test(value)) return 'bad';
    return null;
  },
};

/**
 * What money cannot fix on a G21, and therefore what the "Nachrüstung" row can
 * never contain: ACC needs radar, loom and coding, the M Sport look is bumpers
 * and suspension, and the seat material means a retrim that costs as much as
 * buying the better car. Stated as its own row because a car with nothing
 * retrofittable otherwise reads as a car with nothing missing.
 */
const PERMANENT_GAPS = [
  { label: 'ACC', missing: (car) => !car.features?.includes('Abstandstempomat') },
  { label: 'M Sport', missing: (car) => !car.features?.includes('Sportpaket') },
  {
    label: 'Sitzmaterial',
    missing: (car) => FACT_RULES.interior(car.facts?.interior?.value ?? '') === 'bad',
  },
];

export const permanentGaps = (car) =>
  PERMANENT_GAPS.filter((gap) => gap.missing(car)).map((gap) => gap.label);

// Scales for the two numbers the requirements put a range on. Fixed rather
// than relative to the current selection, so a bar means the same thing
// whichever cars happen to be in the table.
const MILEAGE_TARGET = 70000; // "Zielregion: unter ca. 60.000-70.000 km"
const MILEAGE_LIMIT = 100000; // "deutlich über 100.000 km kommen nicht infrage"
const AGE_TARGET_YEARS = 4; // Zielbild: ca. 2022-2024
const AGE_LIMIT_YEARS = 8;
// The price scale starts at 20.000 rather than zero: nothing in this field is
// cheaper, and a bar from zero would squeeze the whole comparison into its
// last third.
const PRICE_FLOOR = 20000;
const PRICE_TARGET = 30000; // "Preis möglichst um 30.000 EUR"
const PRICE_LIMIT = 35000; // beyond this the car has to be near the Zielbild

const meter = (value, { target, max, min = 0 }) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const at = (n) => Math.min(1, Math.max(0, (n - min) / (max - min)));
  // Never a truly empty bar: a value below the scale's floor is a very good
  // one, and should not read as a missing figure.
  return { fill: Math.max(0.03, at(value)), target: at(target), over: value > target };
};

const euros = (n) => `${n.toLocaleString('de-DE')} €`;

/** Years since first registration, from derived's "2024-06". */
const ageYears = (car) => {
  const match = /^(\d{4})-(\d{2})$/.exec(car.derived?.firstRegistration ?? '');
  if (!match) return null;
  const from = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return (Date.now() - from.getTime()) / (365.25 * 24 * 3600 * 1000);
};

function meterFor(row, car) {
  if (row.key === 'fact:mileage') {
    const bar = meter(car.derived?.mileageKm, { target: MILEAGE_TARGET, max: MILEAGE_LIMIT });
    return bar && { ...bar, hint: `Ziel bis ${euros(MILEAGE_TARGET).replace(' €', ' km')}` };
  }
  if (row.key === 'fact:firstRegistration') {
    const years = ageYears(car);
    const bar = meter(years, { target: AGE_TARGET_YEARS, max: AGE_LIMIT_YEARS });
    return bar && { ...bar, hint: `${years.toFixed(1)} Jahre, Ziel bis ${AGE_TARGET_YEARS}` };
  }
  // Both price rows share one scale, so the retrofit cost is visible as the
  // distance between the two bars.
  if (row.key === 'price' || row.key === 'assessment:effectivePrice') {
    const gross =
      row.key === 'price' ? car.price?.gross : car.assessment?.effectivePrice ?? car.price?.gross;
    const bar = meter(gross, { target: PRICE_TARGET, max: PRICE_LIMIT, min: PRICE_FLOOR });
    return bar && { ...bar, hint: `Ziel bis ${euros(PRICE_TARGET)} (Skala ab ${euros(PRICE_FLOOR)})` };
  }
  return null;
}

/** What one table cell shows: an optional mark, the text, and its tone. */
export function cellFor(row, car) {
  const raw = row.value(car);

  if (row.kind === 'feature') {
    const wanted = KEY_FEATURES.has(row.key.slice('feature:'.length));
    if (raw) return { mark: wanted ? '✅' : '✓', text: '', tone: 'good' };
    return wanted
      ? { mark: '❌', text: '', tone: 'bad' }
      : { mark: '', text: '–', tone: 'empty' };
  }

  if (!raw) return { mark: '', text: '–', tone: 'empty' };

  // Anything listed here is permanently missing, so it is always a ❌ — never a
  // neutral value the eye can skip over.
  if (row.key === 'assessment:gaps') return { mark: '❌', text: raw, tone: 'bad' };

  const fact = row.key.startsWith('fact:') ? row.key.slice('fact:'.length) : null;
  const tone = FACT_RULES[fact] ? FACT_RULES[fact](raw) : null;

  // Colour rows show the paint itself instead of a green tick — a chip says
  // "Skyscraper Grau" faster than a mark does. The ❌ stays, because "kein
  // Weiß" is one of the non-negotiables.
  if (fact === 'color' || fact === 'manufacturerColorName') {
    return { mark: tone === 'bad' ? '❌' : '', text: raw, tone, swatch: swatchFor(raw) };
  }

  return {
    mark: tone === 'good' ? '✅' : tone === 'bad' ? '❌' : '',
    text: raw,
    tone,
    meter: meterFor(row, car),
  };
}
