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
  [/schwarz|black/i, 'schwarz', '#1b1c1e'],
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

  return { mark: tone === 'good' ? '✅' : tone === 'bad' ? '❌' : '', text: raw, tone };
}
