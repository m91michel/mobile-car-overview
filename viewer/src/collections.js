// What makes one collection differ from the next. The table, picker, lists and
// map are shared; a profile only says how rows are built, how a cell is
// coloured and which of the car-only extras (Effektivpreis, Sync, checklists)
// apply. collection.json picks a profile and adds labels on top.

import { useEffect, useState } from 'react';
import { SORTS, STATUSES, buildRows } from './rows.js';
import { cellFor } from './wishlist.js';
import { RULE_TYPES } from './filters.js';
import {
  GENERIC_SORTS,
  HOME,
  buildGenericRows,
  factSorts,
  genericCellFor,
  normalizeItem,
  statusesFor,
} from './generic.js';
import { key as settingKey } from './settings.js';

const PROFILES = {
  // Scraped from mobile.de, judged against CAR-REQUIREMENTS.md.
  cars: {
    normalize: (car) => car,
    buildRows: (cars) => buildRows(cars),
    cellFor: (row, car, _collection, pricing) => cellFor(row, car, pricing),
    sorts: SORTS,
    columnSort: 'price',
    listSort: 'ref',
    ruleTypes: RULE_TYPES,
    pricing: true,
    checklists: true,
  },
  // Everything else: hand-written JSON, see generic.js for the format.
  generic: {
    normalize: normalizeItem,
    buildRows: buildGenericRows,
    cellFor: (row, item, collection) => genericCellFor(row, item, collection),
    sorts: GENERIC_SORTS,
    columnSort: 'name',
    listSort: 'name',
    // The car rules read mileage, registration and fuel; text and price are
    // the two that mean something for any item.
    ruleTypes: RULE_TYPES.filter((rule) => rule.type === 'text' || rule.type === 'price'),
    pricing: false,
    checklists: false,
  },
};

/**
 * collection.json (as served by /api/collections.json) plus everything the
 * viewer derives from it.
 */
export function resolveCollection(meta) {
  const profile = PROFILES[meta.profile] ?? PROFILES.generic;
  return {
    ...meta,
    profile,
    item: meta.item ?? 'Eintrag',
    items: meta.items ?? 'Einträge',
    featuresLabel: meta.featuresLabel ?? 'Merkmale',
    statuses: meta.profile === 'cars' ? STATUSES : statusesFor(meta),
    // Where Luftlinie and the map's ⌂ start: a Kita search measures from the
    // flat, not from the city centre.
    home: meta.home ?? HOME,
    sorts: [...profile.sorts, ...factSorts(meta.sortFacts)],
    listSort: meta.defaultSort ?? profile.listSort,
    columnSort: meta.defaultSort ?? profile.columnSort,
    // The cars keep the bare `car-compare/` keys, so every favourite, note and
    // list stored before collections existed stays exactly where it was, and
    // their sync document is the one it always was. Any other collection gets
    // its own sub-prefix: still inside `car-compare/`, so the JSON export
    // takes it along, and synced through the second document (sync.js).
    key: meta.id === 'cars' ? settingKey : (name) => settingKey(`${meta.id}/${name}`),
    dataUrl: `/api/collections/${meta.id}.json`,
  };
}

/** The collection id in `#/kitas`, or null on the start page. */
export function useRoute() {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/')[0] || null;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
