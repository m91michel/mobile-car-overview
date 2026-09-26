#!/usr/bin/env node
// Import a car that is not on mobile.de, straight from a dealer's own website.
//
//   pnpm dealer -- 'https://www.autohaus-wormser.de/bmw/gebrauchtwagenbestand/#!/vehicles/6846250/...'
//   pnpm dealer -- --refresh      # re-import every dealer car already in data/
//
// Many BMW dealer sites embed the same stock widget (pixel-base, served from
// cdn.dein.auto). It is an Angular app behind a `#!/vehicles/<id>` hash route,
// so the page HTML carries no vehicle data at all; the widget pulls one JSON
// document from api.pixel-base.de. The api key and the dealer's marketplace
// path are only known once the widget has booted, so the page is opened in the
// scraping Chrome and the widget's own request URL is read back from the
// Resource Timing entries -- no key is hard-coded here.
//
// The result is mapped onto the same shape extract.mjs produces for mobile.de
// listings, with mobile.de's own German wording for facts and features, so the
// car lines up with the others in the viewer's union rows instead of opening a
// parallel set of English ones. Anything without a mobile.de counterpart is
// dropped from `features` and survives in `equipment` for reference.
//
// `source` marks the car as not-from-mobile.de; `pnpm refresh` and
// `pnpm available` skip it, because both would look it up on mobile.de.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { openPage } from './cdp.mjs';
import { ensureChrome, PORT } from './chrome.mjs';
import { deriveNumbers, deriveModel } from './extract.mjs';
import { loadRefs, saveRefs, assignRef } from './refs.mjs';
import { loadAssessments, applyAssessment } from './assessment.mjs';
import { writeJsonAtomic } from './atomic.mjs';

const OUT_DIR = resolve('data/listings');
const INDEX_FILE = resolve('data/cars.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pixel-base's feature list is mobile.de's checkbox catalogue in English, so
// most of it maps one to one. Items covered by a fact instead (climate, park
// assists, airbags, E10) and near-duplicates ("Tow bar" next to "Swiveling tow
// bar") are left out on purpose.
const FEATURES = {
  'Ambience light': 'Ambiente-Beleuchtung',
  'Android car': 'Android Auto',
  'Apple CarPlay': 'Apple CarPlay',
  Armrest: 'Armlehne',
  'Automatic dimming rear view mirror': 'Innenspiegel autom. abblendend',
  'Automatic start/stop': 'Start/Stopp-Automatik',
  Bluetooth: 'Bluetooth',
  'Built-in satnav': 'Navigationssystem',
  'Central locking': 'Zentralverriegelung',
  'Cruise control': 'Tempomat',
  'DAB radio': 'Radio DAB',
  'Digital instrument cluster': 'Volldigitales Kombiinstrument',
  'Electric folding side mirrors': 'Elektr. Seitenspiegel anklappbar',
  'Electric seat adjustment': 'Elektr. Sitzeinstellung',
  'Electric seats with memory function': 'Elektr. Sitzeinstellung mit Memory-Funktion',
  'Electric side mirror': 'Elektr. Seitenspiegel',
  'Electric windows': 'Elektr. Fensterheber',
  'Gearshift paddles': 'Schaltwippen',
  'Hands-free system': 'Freisprecheinrichtung',
  'Head-Up Display': 'Head-Up Display',
  'Heated seats': 'Sitzheizung',
  'Heated steering wheel': 'Beheizbares Lenkrad',
  'Induction charging for smartphones': 'Induktionsladen für Smartphones',
  'Integrated music streaming': 'Musikstreaming integriert',
  Isofix: 'Isofix',
  'Keyless central locking (Keyless Entry)': 'Schlüssellose Zentralverriegelung (Keyless)',
  'Leather steering wheel': 'Lederlenkrad',
  'Luggage compartment partition': 'Gepäckraumabtrennung',
  'Lumbar support': 'Lordosenstütze',
  'Multifunction steering wheel': 'Multifunktionslenkrad',
  'On-board computer': 'Bordcomputer',
  'Panoramic roof': 'Panorama-Dach',
  'Power steering': 'Servolenkung',
  'Rain sensors': 'Regensensor',
  'Sound system': 'Soundsystem',
  'Sports seats': 'Sportsitze',
  'Sport suspension': 'Sportfahrwerk',
  'Sports package': 'Sportpaket',
  Touchscreen: 'Touchscreen',
  'Tuner or radio': 'Tuner/Radio',
  USB: 'USB',
  'Voice control': 'Sprachsteuerung',
  'W-Lan / Wifi Hotspot': 'WLAN / Wifi Hotspot',
  'Alloy wheels': 'Leichtmetallfelgen',
  'Electric tailgate': 'Elektr. Heckklappe',
  'Roof rails': 'Dachreling',
  'Summer tyres': 'Sommerreifen',
  'Winter tyres': 'Winterreifen',
  'All season tyres': 'Allwetterreifen',
  'Swiveling tow bar': 'Anhängerkupplung schwenkbar',
  'Detachable tow bar': 'Anhängerkupplung abnehmbar',
  'Fixed tow bar': 'Anhängerkupplung fest',
  'Full service history': 'Scheckheftgepflegt',
  'Non-smoking vehicle': 'Nichtraucher-Fahrzeug',
  ABS: 'ABS',
  'Adaptive cruise control': 'Abstandstempomat',
  'Alarm system': 'Alarmanlage',
  'Blind Spot Assist': 'Totwinkel-Assistent',
  'Cornering light': 'Kurvenlicht',
  'Distance warning indicator': 'Abstandswarner',
  'Driver drowsiness detection alert': 'Müdigkeitswarner',
  'Emergency brake assist': 'Notbremsassistent',
  'Emergency call system': 'Notrufsystem',
  ESP: 'ESP',
  'Glare-free high beam': 'Blendfreies Fernlicht',
  'Headlight sensors': 'Lichtsensor',
  'High beam assist': 'Fernlichtassistent',
  'Hill start assist': 'Berganfahrassistent',
  Immobiliser: 'Elektr. Wegfahrsperre',
  'Lane departure warning': 'Spurhalteassistent',
  'LED daytime running lights': 'LED-Tagfahrlicht',
  'LED headlights': 'LED-Scheinwerfer',
  'Particle filter': 'Partikelfilter',
  'Speed limiter': 'Geschwindigkeitsbegrenzer',
  'Traction control': 'Traktionskontrolle',
  'Traffic sign recognition': 'Verkehrszeichenerkennung',
  'Tyre pressure monitoring system': 'Reifendruckkontrolle',
};

// mobile.de reports park assists as one comma-separated fact.
const PARK_ASSISTS = [
  ['Parking assist (front sensor)', 'Vorne'],
  ['Parking assist (rear sensors)', 'Hinten'],
  ['Parking assist (360° camera)', '360°-Kamera'],
  ['Parking aid (camera)', 'Kamera'],
  ['Parking assist (self-steering)', 'Selbstlenkende Systeme'],
];

const COLOURS = {
  grey: 'Grau', black: 'Schwarz', blue: 'Blau', white: 'Weiß', silver: 'Silber',
  red: 'Rot', green: 'Grün', brown: 'Braun', beige: 'Beige',
};

// seatCoverMaterial is BMW's own category, where Sensatec counts as "Leather".
// mobile.de calls it Kunstleder, so the seller's wording decides first.
function interior(v) {
  const text = v.seatCover ?? '';
  const colour = COLOURS[v.seatCoverBaseColor?.name] ?? null;
  const material =
    /sensatec|veganza/i.test(text) ? 'Kunstleder'
    : /alcantara/i.test(text) ? 'Alcantara'
    : /stoff/i.test(text) ? 'Stoff'
    : /leder|dakota|vernasca|merino/i.test(text) ? 'Vollleder'
    : null;
  return [material, colour].filter(Boolean).join(', ') || null;
}

const titles = (groups = []) => [...new Set(groups.flatMap((g) => g.item.map((i) => i.title1)).filter(Boolean))];
const de = (n) => n.toLocaleString('de-DE');
const monthYear = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);

/** pixel-base vehicle document -> the normalized car shape of extract.mjs. */
export function normalizePixelBase(v, pageUrl) {
  const featureNames = (v.equipment?.feature ?? []).flatMap((g) => g.item.map((i) => i.title1));
  const has = (name) => featureNames.includes(name);
  const features = [...new Set(featureNames.map((name) => FEATURES[name]).filter(Boolean))];
  if (v.driveMechanismType === 'RearWheelDrive') features.push('Heckantrieb');
  if (v.driveMechanismType === 'AllWheelDrive') features.push('Allradantrieb');
  if (v.guaranteeDurationMonth > 0) features.push('Garantie');
  features.sort((a, b) => a.localeCompare(b, 'de'));

  // The German option list names the emission norm more precisely than the
  // `emissionClass` field ("Euro 6e" vs "Euro 6").
  const optionTitles = [...titles(v.equipment?.standard), ...titles(v.equipment?.optional)];
  const euroNorm = optionTitles.join(' ').match(/Euro 6[a-e]?(?:-TEMP)?/)?.[0] ?? v.emissionClass?.name;

  const reserved = v.hasReservation && v.reservedUntil ? v.reservedUntil.slice(0, 10) : null;
  const available = v.availableFrom?.date && Date.parse(v.availableFrom.date) > Date.now()
    ? `Ab ${v.availableFrom.dateString}`
    : 'Sofort';

  const fuel = v.fuel?.groups?.includes('gasoline') ? 'Benzin' : v.fuel?.groups?.includes('diesel') ? 'Diesel' : v.fuel?.name;
  const colour = COLOURS[v.basePaintColor?.name];
  const tech = Object.fromEntries(
    (v.technicalData ?? []).flatMap((g) => g.item.map((i) => [`${g.title}/${i.key}`.trim(), i.stringValue])),
  );

  const raw = {
    damageCondition: ['Fahrzeugzustand', v.isAccidentFree ? 'Gebrauchtfahrzeug, Unfallfrei' : 'Gebrauchtfahrzeug'],
    category: ['Kategorie', v.body?.groups?.includes('station') ? 'Kombi' : v.body?.name],
    modelRange: ['Baureihe', v.baureihe?.name],
    trimLine: ['Ausstattungslinie', v.modelExtension],
    sku: ['Fahrzeugnummer', `${v.kuerzel ?? ''}${v.orderNumber ?? ''}` || null],
    availability: ['Verfügbarkeit', reserved ? `Reserviert bis ${reserved.split('-').reverse().join('.')}` : available],
    countryVersion: ['Herkunft', optionTitles.includes('German version') ? 'Deutsche Ausführung' : null],
    mileage: ['Kilometerstand', v.mileage != null ? `${de(v.mileage)} km` : null],
    cubicCapacity: ['Hubraum', v.cubicCapacity ? `${de(v.cubicCapacity)} cm³` : null],
    power: ['Leistung', v.kw ? `${v.kw} kW (${v.hp} PS)` : null],
    'envkv.engineType': ['Antriebsart', v.pluginHybrid ? 'Plug-in-Hybrid' : 'Verbrennungsmotor'],
    fuel: ['Kraftstoffart', [fuel, has('E10 suitable') ? 'E10-geeignet' : null].filter(Boolean).join(', ')],
    numSeats: ['Anzahl Sitzplätze', v.seatCount],
    doorCount: ['Anzahl der Türen', v.doorsCount >= 4 ? '4/5' : v.doorsCount],
    transmission: ['Getriebe', v.gearbox?.groups?.includes('automatic') ? 'Automatik' : 'Schaltgetriebe'],
    emissionClass: ['Schadstoffklasse', euroNorm],
    firstRegistration: ['Erstzulassung', monthYear(v.dateOfFirstRegistration?.date)],
    numberOfPreviousOwners: ['Anzahl der Fahrzeughalter', v.previousOwnersCount],
    hu: ['HU', v.hasNewTechnicialInspection ? 'Neu' : monthYear(v.dateOfNextTechnicialInspection?.date)],
    climatisation: ['Klimatisierung',
      has('Automatic climate control 3 zones') ? '3-Zonen-Klimaautomatik'
      : has('Automatic climate control 2 zones') ? '2-Zonen-Klimaautomatik'
      : has('Automatic climate control') ? 'Klimaautomatik' : null],
    parkAssists: ['Einparkhilfe', PARK_ASSISTS.filter(([name]) => has(name)).map(([, label]) => label)
      // 360° already implies a camera; listing both would read as two cameras.
      .filter((label, _, all) => !(label === 'Kamera' && all.includes('360°-Kamera'))).join(', ')],
    airbag: ['Airbags', has('Head airbag') ? 'Front-, Seiten- und weitere Airbags' : has('Side airbags') ? 'Front- und Seiten-Airbags' : null],
    manufacturerColorName: ['Farbe (Hersteller)', v.paintColor],
    color: ['Farbe', colour ? `${colour}${v.hasMetallicPaint ? ' Metallic' : ''}` : null],
    interior: ['Innenausstattung', interior(v)],
    trailerLoadBraked: ['Anhängelast gebremst', tech['Zul. Anhängelast/gebremst']],
    trailerLoadUnbraked: ['Anhängelast ungebremst', tech['Zul. Anhängelast/ungebremst']],
    netWeight: ['Gewicht', tech['Gewicht/Leergewicht']],
    cylinder: ['Zylinder', v.cylinderCount],
    fuelTankVolume: ['Tankgröße', tech['Volumen/Tankinhalt']],
    'envkv.energyConsumption': ['Energieverbrauch (komb.)', v.wltpFuelConsumptionCombined ? `${String(v.wltpFuelConsumptionCombined).replace('.', ',')} l/100km` : null],
    'envkv.co2Emissions': ['CO₂-Emissionen (komb.)', v.wltpCo2EmissionCombined ? `${v.wltpCo2EmissionCombined} g/km` : null],
    'envkv.co2Class': ['CO₂-Klasse', v.wltpCo2ClassCombined],
    'envkv.tax': ['Kraftfahrzeugsteuer', v.wltpFuelTax ? `${v.wltpFuelTax} €/Jahr` : null],
  };

  const facts = {};
  for (const [tag, [label, value]] of Object.entries(raw)) {
    if (value == null || value === '') continue;
    facts[tag] = { label, value: String(value), group: tag.startsWith('envkv.') ? 'envkv' : 'vehicle' };
  }

  const contact = v.contact ?? {};
  const location = contact.geoLatitude ? { lat: contact.geoLatitude, lon: contact.geoLongitude } : null;
  const price = v.consumerPrice ?? {};
  const title = [v.manufacturer?.name, v.model?.name, v.modelExtension].filter(Boolean).join(' ');

  return {
    id: `pb-${v.id}`,
    url: pageUrl,
    sourceUrl: pageUrl,
    fetchedAt: new Date().toISOString(),
    source: { kind: 'pixel-base', dealerVehicleId: v.id, vin: v.vin ?? null },

    title,
    shortTitle: [v.manufacturer?.name, v.model?.name].filter(Boolean).join(' '),
    subTitle: v.modelExtension ?? null,
    make: v.manufacturer?.name,
    model: v.model?.name?.replace(/[a-z]+$/, ''),
    category: v.body?.groups?.includes('station') ? 'EstateCar' : null,
    sku: facts.sku?.value ?? null,
    isNew: false,
    kba: v.hsn ? { hsn: v.hsn, tsn: v.tsn } : null,

    price: {
      gross: price.totalPrice ?? null,
      net: price.netPrice ?? null,
      currency: price.currency ?? 'EUR',
      localized: price.totalPrice ? `${de(price.totalPrice)} €` : null,
      vatRate: price.vatDeductible ? price.vatPercentage : null,
      vatNote: price.vatDeductible ? 'MwSt. ausweisbar' : null,
      type: 'FIXED',
    },
    // mobile.de's market rating does not exist off mobile.de.
    priceRating: null,
    listPrice: v.oldListPrice?.totalPrice ? Math.round(v.oldListPrice.totalPrice) : null,
    reservedUntil: reserved,

    facts,
    derived: {
      ...deriveNumbers(facts, location),
      ...deriveModel(facts, features, title),
    },
    features,
    highlights: v.highlights ?? [],
    // The dealer's full German option list, for what the checkbox catalogue
    // cannot say (Shadow Line, Driving Assistant Professional, ...).
    equipment: {
      optional: titles(v.equipment?.optional),
      standard: titles(v.equipment?.standard),
    },

    // pixel-base sizes by `&w=<px>`; stored unsized, like the mobile.de photos.
    images: (v.mediaItems ?? []).filter((m) => m.type === 'Image').map((m) => m.downloadUrl),

    dealer: {
      name: contact.name ?? null,
      type: 'Händler',
      street: contact.address1 ?? null,
      city: [contact.countryCode, contact.zip].filter(Boolean).join('-') + (contact.town ? ` ${contact.town}` : ''),
      country: contact.countryCode ?? null,
      phone: contact.contactTyps?.find((c) => c.isDefault)?.formattedPhone ?? null,
      homepage: contact.website ?? null,
      location,
      openingHours: [],
      rating: null,
    },

    financePlans: [],
  };
}

/** Load the dealer page and read back the vehicle document its widget fetched. */
async function fetchVehicle(page, pageUrl) {
  const vehicleId = pageUrl.match(/#!\/vehicles\/(\d+)/)?.[1];
  if (!vehicleId) throw new Error(`no #!/vehicles/<id> in ${pageUrl}`);

  await page.goto(pageUrl);
  const probe = `performance.getEntriesByType('resource').map((e) => e.name)
    .find((u) => /\\/marketplace\\/[^/]+\\/vehicles\\/${vehicleId}\\?apikey=/.test(u)) ?? 'pending'`;
  const apiUrl = await page.waitForStatus(probe, { timeoutMs: 30000 });
  if (!apiUrl?.startsWith('http')) throw new Error('the stock widget never requested the vehicle (not a pixel-base site?)');

  // Fetched in the page, so it carries the dealer site's own Origin/Referer.
  const vehicle = await page.evaluate(`fetch(${JSON.stringify(apiUrl)}).then((r) => r.ok ? r.json() : null)`);
  if (!vehicle?.id) throw new Error('vehicle document empty - the car may be sold');
  return vehicle;
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const index = existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, 'utf8')) : { cars: [], unavailable: {} };
const urls = args.includes('--refresh')
  ? index.cars.filter((car) => car.source?.kind === 'pixel-base').map((car) => car.sourceUrl)
  : args;

if (!urls.length) {
  console.error("Usage: pnpm dealer -- '<dealer vehicle url>' [...] | --refresh");
  process.exit(1);
}

await ensureChrome();
const page = await openPage(PORT, { newTab: true });
const refs = loadRefs();
const assessments = loadAssessments();
const merged = new Map(index.cars.map((car) => [car.id, car]));
let failed = 0;

try {
  for (const [i, url] of urls.entries()) {
    if (i) await sleep(2000);
    try {
      const car = normalizePixelBase(await fetchVehicle(page, url), url);
      car.ref = assignRef(refs, car.id);
      applyAssessment(assessments, car);
      writeJsonAtomic(resolve(OUT_DIR, `${car.id}.json`), car);
      merged.set(car.id, car);
      console.log(`  #${car.ref} ${car.id}  ${car.title}  ${car.price.localized}` +
        (car.reservedUntil ? `  (reserviert bis ${car.reservedUntil})` : ''));
    } catch (error) {
      failed++;
      console.error(`  failed: ${url}\n    ${error.message}`);
    }
  }
} finally {
  await page.close();
}

writeJsonAtomic(INDEX_FILE, { ...index, updatedAt: new Date().toISOString(), cars: [...merged.values()] });
saveRefs(refs);
process.exit(failed ? 1 : 0);
