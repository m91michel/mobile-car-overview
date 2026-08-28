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

/** Blau, Grau und Schwarz sind gewünscht; Weiß ist raus. Rest: neutral. */
const paint = (value) => {
  if (/wei(ß|ss)/i.test(value)) return 'bad';
  if (/blau|grau|schwarz|anthrazit|saphir/i.test(value)) return 'good';
  return null;
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

  const rule = row.key.startsWith('fact:') ? FACT_RULES[row.key.slice('fact:'.length)] : null;
  const tone = rule ? rule(raw) : null;
  return { mark: tone === 'good' ? '✅' : tone === 'bad' ? '❌' : '', text: raw, tone };
}
