import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import {
  SORTS,
  STATUSES,
  buildRows,
  carLabel,
  carPlace,
  carRef,
  carSubline,
  isSold,
  matchesSearch,
  photo,
  rowDiffers,
  sortCars,
  toCsv,
} from './rows.js';
import { cellFor } from './wishlist.js';
import { download, exportSettings, importSettings, key, today } from './settings.js';
import { DEFAULT_PRICING, applyPricingSettings, withPricingDefaults } from './pricing.js';
import SyncDialog, { syncSummary, useSyncStatus } from './SyncDialog.jsx';
import { useTabStorage } from './useTabStorage.js';
import {
  RULE_TYPES,
  FUEL_OPTIONS,
  CONDITION_OPTIONS,
  emptyRule,
  ruleIsValid,
  filteredIds,
  summarizeFilter,
} from './filters.js';

const MapView = lazy(() => import('./MapView.jsx'));

function SortControl({ className, label, sortKey, setSortKey, desc, setDesc }) {
  return (
    <div className={`sort ${className ?? ''}`}>
      <span className="muted">{label}</span>
      {SORTS.map((sort) => (
        <button
          key={sort.key}
          className={sortKey === sort.key ? 'on' : ''}
          onClick={() => setSortKey(sort.key)}
        >
          {sort.label}
        </button>
      ))}
      <button onClick={() => setDesc(!desc)} title={desc ? 'Absteigend' : 'Aufsteigend'}>
        {desc ? '↓' : '↑'}
      </button>
    </div>
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Note and links for one car; drafts locally and only reports on save. */
function NoteEditor({ car, onSave, onClose }) {
  const ref = useDrawer(true);
  const [note, setNote] = useState(car.notes?.note ?? '');
  const [links, setLinks] = useState(
    car.notes?.links?.length ? car.notes.links.map((l) => ({ ...l })) : [{ label: '', url: '' }],
  );

  const setLink = (index, patch) =>
    setLinks((all) => all.map((link, i) => (i === index ? { ...link, ...patch } : link)));

  return (
    <dialog
      className="editor"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="drawer-head">
        <strong>Notiz</strong>
        <span className="muted">
          {carRef(car)} {car.shortTitle ?? carLabel(car)}
        </span>
        <div className="spacer" />
        <button onClick={onClose} title="Schließen">
          ✕
        </button>
      </header>

      <div className="editor-body">
        <label className="field">
          <span className="muted">Notiz</span>
          <textarea
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Was du dir zu diesem Fahrzeug merken willst"
          />
        </label>

        <div className="field">
          <span className="muted">Links</span>
          {links.map((link, index) => (
            <div className="link-row" key={index}>
              <input
                value={link.label}
                onChange={(e) => setLink(index, { label: e.target.value })}
                placeholder="Bezeichnung"
                aria-label="Bezeichnung"
              />
              <input
                value={link.url}
                onChange={(e) => setLink(index, { url: e.target.value })}
                placeholder="https://..."
                aria-label="URL"
              />
              <button
                onClick={() => setLinks((all) => all.filter((_, i) => i !== index))}
                title="Link entfernen"
              >
                ✕
              </button>
            </div>
          ))}
          <button onClick={() => setLinks((all) => [...all, { label: '', url: '' }])}>
            Link hinzufügen
          </button>
        </div>
      </div>

      <footer className="editor-foot">
        <button onClick={onClose}>Abbrechen</button>
        <button className="primary" onClick={() => onSave({ note, links })}>
          Speichern
        </button>
      </footer>
    </dialog>
  );
}

/**
 * The Effektivpreis's knobs (mileage, AHK, facelift, boni) in localStorage
 * (car-compare/pricing) rather than the data/assessment.json server default,
 * and synced across devices along with favourites and notes (sync.js).
 */
function PricingSettings({ pricing, onChange, onReset, onClose }) {
  const ref = useDrawer(true);
  const num = (key, fallback = 0) => (e) => onChange({ [key]: Number(e.target.value) || fallback });

  return (
    <dialog
      className="editor"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="drawer-head">
        <strong>Preisanpassung</strong>
        <span className="muted">wirkt auf den Effektivpreis, wird mit Sync geteilt</span>
        <div className="spacer" />
        <button onClick={onClose} title="Schließen">
          ✕
        </button>
      </header>

      <div className="editor-body">
        <label className="check">
          <input
            type="checkbox"
            checked={pricing.mileageEnabled}
            onChange={(e) => onChange({ mileageEnabled: e.target.checked })}
          />
          Laufleistung/Alter berücksichtigen
        </label>
        <label className="field">
          <span className="muted">Referenz-Laufleistung (km/Jahr)</span>
          <input
            type="number"
            min="0"
            step="500"
            disabled={!pricing.mileageEnabled}
            value={pricing.referenceKmPerYear}
            onChange={num('referenceKmPerYear')}
          />
        </label>
        <label className="field">
          <span className="muted">€ pro km Abweichung</span>
          <input
            type="number"
            min="0"
            step="0.01"
            disabled={!pricing.mileageEnabled}
            value={pricing.ratePerKm}
            onChange={num('ratePerKm')}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={pricing.ahkEnabled !== false}
            onChange={(e) => onChange({ ahkEnabled: e.target.checked })}
          />
          Fehlende AHK als Nachrüstung berücksichtigen
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={pricing.lciMalusEnabled}
            onChange={(e) => onChange({ lciMalusEnabled: e.target.checked })}
          />
          Negativpunkte für Fahrzeuge ohne Facelift (vor LCI)
        </label>
        <label className="field">
          <span className="muted">Facelift-Negativpunkte (€)</span>
          <input
            type="number"
            min="0"
            step="50"
            disabled={!pricing.lciMalusEnabled}
            value={pricing.lciMalus}
            onChange={num('lciMalus')}
          />
        </label>

        <p className="muted pricing-section">
          Boni senken den Effektivpreis: ein Auto, das bei gleichem Preis mehr wert ist, wird
          effektiv günstiger.
        </p>
        {[
          ['bonus330', '330er (330i/330e)'],
          ['bonusMSport', 'M Sportpaket'],
          ['bonusHybrid', 'Hybrid (320e/330e)'],
        ].map(([key, label]) => (
          <div className="pricing-bonus" key={key}>
            <label className="check">
              <input
                type="checkbox"
                checked={pricing[`${key}Enabled`]}
                onChange={(e) => onChange({ [`${key}Enabled`]: e.target.checked })}
              />
              Bonus {label}
            </label>
            <input
              type="number"
              min="0"
              step="100"
              aria-label={`Bonus ${label} (€)`}
              disabled={!pricing[`${key}Enabled`]}
              // 0 shows as an empty field: not configured yet, not "worth 0".
              value={pricing[key] || ''}
              placeholder="0"
              onChange={num(key)}
            />
            <span className="muted">€</span>
          </div>
        ))}
      </div>

      <footer className="editor-foot">
        <button onClick={onReset}>Zurücksetzen</button>
        <button className="primary" onClick={onClose}>
          Fertig
        </button>
      </footer>
    </dialog>
  );
}

function CarOption({ car, active, onToggle, favourite, onFavourite, removed, onRemove }) {
  return (
    <label
      className={`car-option ${active ? 'on' : ''} ${isSold(car) ? 'sold' : ''} ${removed ? 'removed' : ''}`}
      title={`${carRef(car)} ${carLabel(car)}`.trim()}
    >
      <input type="checkbox" checked={active} onChange={onToggle} />
      {car.images?.[0] && (
        <img src={photo(car.images[0], 'mo-240')} alt="" referrerPolicy="no-referrer" />
      )}
      <span className="car-option-text">
        <span className="car-option-title">
          {carRef(car) && <span className="ref">{carRef(car)}</span>}
          {carLabel(car)}
        </span>
        <span className="muted">
          {car.price?.localized ?? '—'} · {carSubline(car)}
          {isSold(car) && <span className="gone">verkauft</span>}
          {removed && <span className="gone gone-neutral">ausgeblendet</span>}
        </span>
        {carPlace(car) && <span className="car-option-place">📍 {carPlace(car)}</span>}
      </span>
      {car.url && (
        <a
          className="open"
          href={car.url}
          target="_blank"
          rel="noreferrer"
          // Opening the listing must not also tick the checkbox.
          onClick={(event) => event.stopPropagation()}
          title="Inserat öffnen"
        >
          ↗
        </a>
      )}
      <button
        className={`fav ${favourite ? 'on' : ''}`}
        // Inside a <label>, a click would otherwise reach the checkbox too.
        onClick={(event) => {
          event.preventDefault();
          onFavourite();
        }}
        title={favourite ? 'Favorit entfernen' : 'Als Favorit merken'}
      >
        {favourite ? '★' : '☆'}
      </button>
      <button
        className={`remove ${removed ? 'on' : ''}`}
        onClick={(event) => {
          event.preventDefault();
          onRemove();
        }}
        title={removed ? 'Wiederherstellen' : 'Ausblenden (zu alt, Unfall, verkauft, ...)'}
      >
        {removed ? '↺' : '🗑'}
      </button>
    </label>
  );
}

/**
 * The header's settings menu. A native <details> for the same reason the
 * drawers are <dialog>s: the open/close toggle and the keyboard handling come
 * with the element. Only the two things it does not give -- closing on an
 * outside click and on Escape -- are wired up by hand.
 */
function Menu({ label, title, children }) {
  const ref = useRef(null);

  useEffect(() => {
    const close = (event) => {
      if (!ref.current?.open) return;
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && ref.current.contains(event.target)) return;
      ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details className="menu" ref={ref}>
      <summary title={title}>{label}</summary>
      {/* Clicks bubble to here, so picking any item closes the menu. */}
      <div className="menu-items" onClick={() => { ref.current.open = false; }}>
        {children}
      </div>
    </details>
  );
}

/** A native <dialog> brings Escape, the backdrop and focus trapping along. */
function useDrawer(open) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return ref;
}

export default function App() {
  const [cars, setCars] = useState(null);
  const [editing, setEditing] = useState(null); // car id being edited
  const [error, setError] = useState(null);
  // Every view setting is persisted, so a reload after `pnpm scrape` lands on
  // the same comparison. null selection = "nothing picked yet" -> show all.
  // Which cars are open, sorting and table/map are per tab (useTabStorage), so
  // two windows can show two comparisons; everything else is per browser.
  const [selected, setSelected] = useTabStorage(key('selected'), null);
  const [order, setOrder] = useLocalStorage(key('order'), []);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(key('hidden'), []);
  const [diffOnly, setDiffOnly] = useTabStorage(key('diff-only'), false);
  const [featuresOnly, setFeaturesOnly] = useTabStorage(key('features-only'), false);
  // Two independent orders: the drawer is for finding a car, the columns are
  // for reading the comparison, and those want different sorts.
  const [listSort, setListSort] = useTabStorage(key('sort-list'), 'ref');
  const [listDesc, setListDesc] = useTabStorage(key('sort-list-desc'), false);
  const [columnSort, setColumnSort] = useTabStorage(key('sort-columns'), 'price');
  const [columnDesc, setColumnDesc] = useTabStorage(key('sort-columns-desc'), false);
  // A shortlist you keep while working through the field, independent of which
  // cars happen to be in the table right now.
  const [favourites, setFavourites] = useLocalStorage(key('favourites'), []);
  // Named selections, so narrowing the table to a shortlist is not a one-way
  // door back through 30 checkboxes.
  const [lists, setLists] = useLocalStorage(key('lists'), []);
  // Cars decided against for good (too old, accident, sold) -- kept out of the
  // comparison by default, but not deleted: nothing here ever touches
  // data/listings/*.json, so a mistaken hide costs one click to undo.
  const [removed, setRemoved] = useLocalStorage(key('removed'), []);
  const [notes, setNotes] = useLocalStorage(key('notes'), {});
  const [statuses, setStatuses] = useLocalStorage(key('status'), {});
  const [favouritesFirst, setFavouritesFirst] = useTabStorage(key('favourites-first'), false);
  // The Effektivpreis's mileage/facelift knobs -- see PricingSettings above.
  const [pricing, setPricing] = useLocalStorage(key('pricing'), DEFAULT_PRICING);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const syncStatus = useSyncStatus();
  // Table is the comparison; the map is the same `shown` set, just plotted
  // on dealer coordinates. Persisted so a reload after picking Favoriten
  // stays on the map.
  const [view, setView] = useTabStorage(key('view'), 'table');
  const [dragKey, setDragKey] = useState(null);
  const [openDrawer, setOpenDrawer] = useState(null); // 'cars' | 'favourites' | 'lists' | 'rows'
  const carDrawer = useDrawer(openDrawer === 'cars');
  const favDrawer = useDrawer(openDrawer === 'favourites');
  const listDrawer = useDrawer(openDrawer === 'lists');
  const rowDrawer = useDrawer(openDrawer === 'rows');
  // The filter builder's draft, kept outside `lists` until it is saved (or
  // reloaded here for editing an existing filter -- see editFilter below).
  // Hidden by default: clicking an existing filter's row opens it pre-filled
  // (so seeing its rules and changing them is the same click), "+ Neue Liste"
  // opens it blank -- there is no third way in.
  const [builderOpen, setBuilderOpen] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [draftRules, setDraftRules] = useState([emptyRule()]);
  // Which saved filter (by its current name) the builder is editing, if any --
  // so typing a new name and saving renames it in place instead of leaving
  // the old entry behind and adding a second one under the new name.
  const [editingName, setEditingName] = useState(null);
  const [flash, setFlash] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(() => {
    fetch('/api/cars.json')
      .then((res) => res.json())
      .then((data) => {
        setCars(data.cars);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(load, [load]);

  // A sold car is still worth keeping around (see isSold's grey-out styling),
  // but not in the working comparison -- so every load folds newly-sold ids
  // into `removed`, the same bucket a manual hide uses. Never removes an id,
  // only adds: restoring one by hand is not undone by the next reload unless
  // that reload is what re-discovers it as sold.
  useEffect(() => {
    if (!cars) return;
    const soldIds = cars.filter(isSold).map((c) => c.id);
    if (!soldIds.length) return;
    setRemoved((current) => {
      const missing = soldIds.filter((id) => !current.includes(id));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [cars, setRemoved]);

  // Re-derives the Effektivpreis with the live pricing settings, overriding
  // the server default baked into data/cars.json (scripts/assessment.mjs).
  const pricingSettings = useMemo(() => withPricingDefaults(pricing), [pricing]);
  const priced = useMemo(
    () => (cars ?? []).map((car) => applyPricingSettings(car, pricingSettings)),
    [cars, pricingSettings],
  );

  // Notes are yours, not scraped, so they live beside the view state rather
  // than in the listing files, and are joined onto the cars here.
  const withNotes = useMemo(
    () => priced.map((car) => ({ ...car, notes: notes[car.id], status: statuses[car.id] })),
    [priced, notes, statuses],
  );

  const setStatus = (id, value) =>
    setStatuses((all) => {
      const next = { ...all };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });

  const saveNotes = (id, entry) => {
    const cleaned = {
      note: entry.note.trim(),
      links: entry.links
        .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
        .filter((link) => link.url),
    };
    const next = { ...notes };
    if (cleaned.note || cleaned.links.length) {
      next[id] = { ...cleaned, updatedAt: new Date().toISOString() };
    } else {
      delete next[id]; // An emptied note should not leave a husk behind.
    }
    setNotes(next);
  };

  const listCars = useMemo(
    () => sortCars(withNotes, listSort, listDesc),
    [withNotes, listSort, listDesc],
  );

  // Picker search. Not persisted: a stale term would hide cars on the next open.
  const [search, setSearch] = useState('');
  const searchInput = useRef(null);
  const pickerCars = useMemo(
    () => listCars.filter((car) => matchesSearch(car, search)),
    [listCars, search],
  );
  useEffect(() => {
    if (openDrawer === 'cars') searchInput.current?.focus();
  }, [openDrawer]);

  // Every car minus the hidden ones -- the "Alle" list, the picker's own
  // "Alle" button, and the default ("nothing chosen yet") view all mean the
  // same thing, so they share this instead of three copies of the filter.
  const visibleIds = useMemo(
    () => (cars ?? []).filter((c) => !removed.includes(c.id)).map((c) => c.id),
    [cars, removed],
  );

  // Same idea, as cars instead of ids: what a saved filter's rules run
  // against, so a hidden car -- sold, or judged out by hand -- never earns
  // its way back into "M Sport" or any other list via its rules. Only the
  // "Ausgeblendet" list itself, and a manually ticked checkbox, ever show one.
  const visibleCars = useMemo(
    () => withNotes.filter((c) => !removed.includes(c.id)),
    [withNotes, removed],
  );

  // A hidden car only drops out of the *default* "nothing chosen yet" view --
  // a manually ticked checkbox or the "Ausgeblendet" list itself always wins,
  // so a hidden car stays reviewable there; every other saved list or filter
  // filters it out too (see visibleCars / the Listen drawer below).
  const selectedIds = useMemo(() => {
    if (!cars) return [];
    if (selected === null) return visibleIds;
    return cars.filter((c) => selected.includes(c.id)).map((c) => c.id);
  }, [cars, selected, visibleIds]);

  const shown = useMemo(() => {
    const picked = sortCars(
      withNotes.filter((c) => selectedIds.includes(c.id)),
      columnSort,
      columnDesc,
    );
    if (!favouritesFirst) return picked;
    // Pulled to the front, but each group keeps the chosen sort.
    return [
      ...picked.filter((c) => favourites.includes(c.id)),
      ...picked.filter((c) => !favourites.includes(c.id)),
    ];
  }, [withNotes, selectedIds, columnSort, columnDesc, favouritesFirst, favourites]);

  const allRows = useMemo(() => buildRows(shown), [shown]);
  const hidden = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);

  // Rows follow the stored order; anything new (a freshly scraped car brings
  // new features with it) lands at the end in its default position.
  const orderedRows = useMemo(() => {
    const byKey = new Map(allRows.map((r) => [r.key, r]));
    const out = [];
    const seen = new Set();
    for (const rowKey of order) {
      const row = byKey.get(rowKey);
      if (row && !seen.has(rowKey)) {
        out.push(row);
        seen.add(rowKey);
      }
    }
    for (const row of allRows) if (!seen.has(row.key)) out.push(row);
    return out;
  }, [allRows, order]);

  const visibleRows = useMemo(
    () =>
      orderedRows.filter((row) => {
        if (hidden.has(row.key)) return false;
        if (featuresOnly && row.kind !== 'feature') return false;
        if (diffOnly && shown.length > 1 && !rowDiffers(row, shown)) return false;
        return true;
      }),
    [orderedRows, hidden, diffOnly, featuresOnly, shown],
  );

  const toggleCar = (id) =>
    setSelected((current) => {
      // Same "everything but hidden" starting point as selectedIds' default,
      // or the very first checkbox click would silently bring every hidden
      // car back into the comparison.
      const base = current ?? visibleIds;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const saveList = (name, ids) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setLists((all) => [
      ...all.filter((list) => list.name !== trimmed),
      { name: trimmed, ids: [...ids] },
    ]);
    setListName('');
  };

  // A filter list carries `rules`, not `ids` -- its matches are computed fresh
  // every render (see `filteredIds(withNotes, list.rules)` below), so nothing
  // ever needs to be re-saved when a car is added or its price changes.
  const saveFilter = (name, rules) => {
    const trimmed = name.trim();
    const valid = rules.filter(ruleIsValid);
    if (!trimmed || valid.length === 0) return;
    setLists((all) => [
      // Drop both the target name (about to be (re)written) and the filter
      // being edited under its old name, if that is a different name --
      // otherwise a rename would leave the old entry behind as a duplicate.
      ...all.filter((list) => list.name !== trimmed && list.name !== editingName),
      { name: trimmed, rules: valid },
    ]);
    // Saving a filter is also the point of building it -- apply it straight
    // away instead of making that a second click on the freshly saved row.
    // The builder is deliberately left open on what was just saved, not
    // cleared -- clicking the row itself does that (see editFilter below).
    setSelected(filteredIds(visibleCars, valid));
    setEditingName(trimmed);
  };

  const editFilter = (list) => {
    setFilterName(list.name);
    // acc/ahk carry no `value` -- leave those rules as they are.
    setDraftRules(
      list.rules.map((rule) => (rule.value === undefined ? { ...rule } : { ...rule, value: String(rule.value) })),
    );
    setEditingName(list.name);
    setBuilderOpen(true);
  };

  const newFilter = () => {
    setFilterName('');
    setDraftRules([emptyRule()]);
    setEditingName(null);
    setBuilderOpen(true);
  };

  const sameAsSelection = (ids) =>
    ids.length === selectedIds.length && ids.every((id) => selectedIds.includes(id));

  const isFavourite = (id) => favourites.includes(id);

  const toggleFavourite = (id) =>
    setFavourites((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const favouriteCars = useMemo(
    () => listCars.filter((car) => favourites.includes(car.id)),
    [listCars, favourites],
  );

  // What Favoriten actually loads into the comparison -- a hidden favourite
  // still shows (dimmed) in the dedicated Favoriten drawer so it can be
  // restored, but it does not count or load from here, same as any other list.
  const visibleFavourites = useMemo(
    () => favourites.filter((id) => !removed.includes(id)),
    [favourites, removed],
  );

  const isRemoved = (id) => removed.includes(id);

  const toggleRemoved = (id) =>
    setRemoved((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const removedCars = useMemo(
    () => listCars.filter((car) => removed.includes(car.id)),
    [listCars, removed],
  );

  const toggleRow = (rowKey) =>
    setHiddenKeys((keys) =>
      keys.includes(rowKey) ? keys.filter((k) => k !== rowKey) : [...keys, rowKey],
    );

  /** Move relative to the *visible* neighbour, so hidden rows never swallow a click. */
  const moveRow = (rowKey, direction) => {
    const visibleKeys = visibleRows.map((r) => r.key);
    const neighbour = visibleKeys[visibleKeys.indexOf(rowKey) + direction];
    if (neighbour === undefined) return;
    dropRow(rowKey, neighbour, direction > 0 ? 'after' : 'before');
  };

  const dropRow = (rowKey, targetKey, position = 'before') => {
    if (rowKey === targetKey) return;
    const keys = orderedRows.map((r) => r.key).filter((k) => k !== rowKey);
    const at = keys.indexOf(targetKey);
    if (at === -1) return;
    keys.splice(position === 'after' ? at + 1 : at, 0, rowKey);
    setOrder(keys);
  };

  // The CSV is the comparison as it stands on screen; the JSON is the setup that
  // produced it. Different things, so they are two separate exports.
  const exportCsv = () =>
    download(`fahrzeugvergleich-${today()}.csv`, toCsv(visibleRows, shown), 'text/csv;charset=utf-8');

  const exportJson = () =>
    download(
      `fahrzeugvergleich-einstellungen-${today()}.json`,
      JSON.stringify(exportSettings(), null, 2),
      'application/json',
    );

  const runImport = async (file) => {
    if (!file) return;
    // An import replaces the whole setup, and notes and lists are typed by hand
    // and nowhere else -- so ask before overwriting them.
    if (!window.confirm('Importieren ersetzt Auswahl, Zeilen, Favoriten, Listen, Notizen und Status in diesem Browser. Fortfahren?'))
      return;
    try {
      const count = importSettings(await file.text());
      setFlash(`${count} Einstellungen aus ${file.name} importiert.`);
    } catch (err) {
      setFlash(`Import fehlgeschlagen: ${err.message}`);
    }
  };

  const pinRow = (rowKey) =>
    setOrder([rowKey, ...orderedRows.map((r) => r.key).filter((k) => k !== rowKey)]);

  if (error) return <p className="notice">Daten konnten nicht geladen werden: {error}</p>;
  if (!cars) return <p className="notice">Lade Fahrzeuge…</p>;
  if (cars.length === 0)
    return <p className="notice">Keine JSON-Dateien in <code>data/listings/</code>. Erst <code>pnpm scrape</code> laufen lassen.</p>;

  return (
    <div className="app">
      <header className="bar">
        <h1>Fahrzeugvergleich</h1>
        <button className="drawer-open" onClick={() => setOpenDrawer('cars')}>
          <span className="bar-text hide-narrow">Fahrzeuge</span> <strong>{shown.length}</strong>
          <span className="muted">/ {cars.length}</span>
        </button>
        <button className="drawer-open" onClick={() => setOpenDrawer('favourites')}>
          <span className="star">★</span> <strong>{favourites.length}</strong>
        </button>
        <button className="drawer-open" onClick={() => setOpenDrawer('lists')}>
          Listen <strong>{lists.length}</strong>
        </button>
        {view === 'table' && (
          <button className="drawer-open" onClick={() => setOpenDrawer('rows')}>
            <span className="bar-text hide-narrow">Zeilen</span> <strong>{visibleRows.length}</strong>
            <span className="muted">/ {allRows.length}</span>
          </button>
        )}
        <div className="sort view-switch" role="group" aria-label="Ansicht">
          <button
            className={view === 'table' ? 'on' : ''}
            onClick={() => setView('table')}
          >
            Tabelle
          </button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>
            Karte
          </button>
        </div>
        <div className="spacer" />
        {view === 'table' && (
          <div className="table-tools">
            <label className="check">
              <input
                type="checkbox"
                checked={diffOnly}
                onChange={(e) => setDiffOnly(e.target.checked)}
              />
              Nur Unterschiede
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={featuresOnly}
                onChange={(e) => setFeaturesOnly(e.target.checked)}
              />
              Nur Ausstattung
            </label>
            <label className="check" title="Favoriten stehen links, unabhängig von der Spaltensortierung">
              <input
                type="checkbox"
                checked={favouritesFirst}
                onChange={(e) => setFavouritesFirst(e.target.checked)}
              />
              <span className="star">★</span> zuerst
            </label>
            <SortControl
              label="Spalten"
              sortKey={columnSort}
              setSortKey={setColumnSort}
              desc={columnDesc}
              setDesc={setColumnDesc}
            />
          </div>
        )}
        <Menu label="⚙" title="Einstellungen">
          <button onClick={load}>Neu laden</button>
          <button onClick={() => setPricingOpen(true)}>
            Preisanpassung <span className="muted">Effektivpreis</span>
          </button>
          <button onClick={() => setSyncOpen(true)}>
            Sync <span className="muted">{syncSummary(syncStatus)}</span>
          </button>
          <button onClick={exportCsv} disabled={shown.length === 0}>
            CSV-Export <span className="muted">sichtbarer Vergleich</span>
          </button>
          <button onClick={exportJson}>
            JSON-Export <span className="muted">Auswahl, Listen, Notizen</span>
          </button>
          <button onClick={() => fileInput.current?.click()}>
            JSON-Import <span className="muted">ersetzt die Einstellungen</span>
          </button>
          <a href="/checkliste.html">
            Probefahrt-Checkliste <span className="muted">#48, fürs Handy</span>
          </a>
        </Menu>
      </header>

      {/* Kept out of the menu: it has to survive the menu closing on the click
          that opens the file picker. */}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first, so picking the same file twice fires onChange again.
          event.target.value = '';
          runImport(file);
        }}
      />

      {flash && (
        <p className="flash" onClick={() => setFlash(null)} title="Ausblenden">
          {flash}
        </p>
      )}

      {pricingOpen && (
        <PricingSettings
          pricing={pricingSettings}
          onChange={(patch) => setPricing((current) => ({ ...current, ...patch }))}
          onReset={() => setPricing(DEFAULT_PRICING)}
          onClose={() => setPricingOpen(false)}
        />
      )}

      {syncOpen && (
        <SyncDialog
          cars={cars}
          onClose={() => setSyncOpen(false)}
          onDone={(message) => {
            setSyncOpen(false);
            setFlash(message);
          }}
        />
      )}

      {editing && (
        <NoteEditor
          car={withNotes.find((car) => car.id === editing)}
          onClose={() => setEditing(null)}
          onSave={(entry) => {
            saveNotes(editing, entry);
            setEditing(null);
          }}
        />
      )}

      <dialog
        className="drawer"
        ref={carDrawer}
        onClose={() => setOpenDrawer(null)}
        onClick={(e) => {
          if (e.target === carDrawer.current) setOpenDrawer(null); // backdrop
        }}
      >
        <header className="drawer-head">
          <strong>Fahrzeuge</strong>
          <span className="muted">
            {shown.length} von {cars.length}
          </span>
          <div className="spacer" />
          <button
            onClick={() => setSelected([...visibleIds])}
            title="Alle außer den ausgeblendeten"
          >
            Alle
          </button>
          <button onClick={() => setSelected([])}>Keine</button>
          <button onClick={() => setOpenDrawer(null)} title="Schließen">
            ✕
          </button>
        </header>
        <SortControl
          className="drawer-sort"
          label="Liste"
          sortKey={listSort}
          setSortKey={setListSort}
          desc={listDesc}
          setDesc={setListDesc}
        />
        <div className="drawer-search">
          <input
            ref={searchInput}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the top hit's listing -- "#74 ⏎" is the fast path.
              if (e.key === 'Enter' && pickerCars[0]?.url) {
                window.open(pickerCars[0].url, '_blank', 'noreferrer');
              }
              // First Escape clears the term, the second closes the drawer.
              if (e.key === 'Escape' && search) {
                e.preventDefault();
                setSearch('');
              }
            }}
            placeholder="Suche: #74, ID, Name, Ort, PLZ, Händler …"
            aria-label="Fahrzeuge durchsuchen"
          />
          {search && (
            <span className="muted">
              {pickerCars.length} Treffer{pickerCars[0]?.url ? ' · ⏎ öffnet den ersten' : ''}
            </span>
          )}
        </div>
        <ul className="drawer-list">
          {pickerCars.length === 0 && <li className="drawer-empty muted">Kein Treffer.</li>}
          {pickerCars.map((car) => (
            <li key={car.id}>
              <CarOption
                car={car}
                active={selectedIds.includes(car.id)}
                onToggle={() => toggleCar(car.id)}
                favourite={isFavourite(car.id)}
                onFavourite={() => toggleFavourite(car.id)}
                removed={isRemoved(car.id)}
                onRemove={() => toggleRemoved(car.id)}
              />
            </li>
          ))}
        </ul>
      </dialog>

      <dialog
        className="drawer"
        ref={favDrawer}
        onClose={() => setOpenDrawer(null)}
        onClick={(e) => {
          if (e.target === favDrawer.current) setOpenDrawer(null); // backdrop
        }}
      >
        <header className="drawer-head">
          <strong>Favoriten</strong>
          <span className="muted">{favouriteCars.length}</span>
          <div className="spacer" />
          <button
            onClick={() => setSelected([...visibleFavourites])}
            disabled={visibleFavourites.length === 0}
            title="Nur die Favoriten vergleichen (ausgeblendete ausgenommen)"
          >
            Vergleichen
          </button>
          <button onClick={() => setOpenDrawer(null)} title="Schließen">
            ✕
          </button>
        </header>
        {favouriteCars.length === 0 ? (
          <p className="drawer-empty muted">
            Noch keine Favoriten. Der Stern oben links auf dem Fahrzeugbild merkt einen vor.
          </p>
        ) : (
          <ul className="drawer-list">
            {favouriteCars.map((car) => (
              <li key={car.id}>
                <CarOption
                  car={car}
                  active={selectedIds.includes(car.id)}
                  onToggle={() => toggleCar(car.id)}
                  favourite
                  onFavourite={() => toggleFavourite(car.id)}
                  removed={isRemoved(car.id)}
                  onRemove={() => toggleRemoved(car.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </dialog>

      {shown.length === 0 ? (
        <p className="notice">
          Kein Fahrzeug ausgewählt.{' '}
          <button onClick={() => setOpenDrawer('cars')}>Fahrzeuge wählen</button>
        </p>
      ) : view === 'map' ? (
        <Suspense fallback={<p className="notice">Lade Karte…</p>}>
          <MapView cars={shown} favourites={favourites} />
        </Suspense>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="row-head">Merkmal</th>
                {shown.map((car) => (
                  <th key={car.id} className={isSold(car) ? 'sold' : ''}>
                    <div className="hero-wrap">
                      {car.images?.[0] && (
                        <img
                          className="hero"
                          src={photo(car.images[0], 'mo-1024')}
                          alt=""
                          referrerPolicy="no-referrer"
                        />
                      )}
                      <button
                        className={`col-fav ${isFavourite(car.id) ? 'on' : ''}`}
                        onClick={() => toggleFavourite(car.id)}
                        title={isFavourite(car.id) ? 'Favorit entfernen' : 'Als Favorit merken'}
                      >
                        {isFavourite(car.id) ? '★' : '☆'}
                      </button>
                      <button
                        className={`col-note ${car.notes ? 'on' : ''}`}
                        onClick={() => setEditing(car.id)}
                        title={car.notes ? 'Notiz bearbeiten' : 'Notiz hinzufügen'}
                      >
                        ✎
                      </button>
                      <button
                        className="col-remove"
                        onClick={() => toggleCar(car.id)}
                        title="Fahrzeug aus dem Vergleich nehmen"
                      >
                        ✕
                      </button>
                      <button
                        className={`col-hide ${isRemoved(car.id) ? 'on' : ''}`}
                        onClick={() => toggleRemoved(car.id)}
                        title={
                          isRemoved(car.id)
                            ? 'Wiederherstellen'
                            : 'Ausblenden (zu alt, Unfall, verkauft, ...)'
                        }
                      >
                        {isRemoved(car.id) ? '↺' : '🗑'}
                      </button>
                    </div>
                    <a
                      className="head-title"
                      href={car.url}
                      target="_blank"
                      rel="noreferrer"
                      title={`${carRef(car)} ${carLabel(car)}`.trim()}
                    >
                      {carRef(car) && <span className="ref">{carRef(car)}</span>}
                      {carLabel(car)}
                    </a>
                    <span className="price">
                      {car.price?.localized ?? '—'}
                      {isSold(car) && <span className="gone">verkauft</span>}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.key}
                  className={dragKey === row.key ? 'dragging' : ''}
                  onDragOver={(e) => {
                    if (dragKey) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragKey) dropRow(dragKey, row.key);
                    setDragKey(null);
                  }}
                >
                  <th
                    className="row-head"
                    draggable
                    onDragStart={() => setDragKey(row.key)}
                    onDragEnd={() => setDragKey(null)}
                  >
                    <div className="row-head-inner">
                      <span className="grip" aria-hidden="true">⠿</span>
                      <span className="label" title={row.label}>
                        {row.label}
                      </span>
                      <span className="row-actions">
                        <button onClick={() => pinRow(row.key)} title="Nach ganz oben">⤒</button>
                        <button onClick={() => moveRow(row.key, -1)} title="Nach oben">↑</button>
                        <button onClick={() => moveRow(row.key, 1)} title="Nach unten">↓</button>
                        <button onClick={() => toggleRow(row.key)} title="Zeile ausblenden">✕</button>
                      </span>
                    </div>
                  </th>
                  {shown.map((car) => {
                    if (row.kind === 'status') {
                      return (
                        <td key={car.id} className={isSold(car) ? 'sold' : ''}>
                          <div className="cell">
                            <select
                              className="status"
                              data-status={car.status ?? ''}
                              value={car.status ?? ''}
                              onChange={(e) => setStatus(car.id, e.target.value)}
                              aria-label="Status"
                            >
                              {STATUSES.map((status) => (
                                <option key={status.key} value={status.key}>
                                  {status.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                      );
                    }
                    if (row.kind === 'links') {
                      const links = car.notes?.links ?? [];
                      return (
                        <td
                          key={car.id}
                          className={`${links.length ? '' : 'empty'} ${isSold(car) ? 'sold' : ''}`}
                        >
                          <div className="cell">
                            {links.length === 0
                              ? '–'
                              : links.map((link) => (
                                  <a
                                    key={link.url}
                                    className="note-link"
                                    href={link.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {link.label || hostOf(link.url)}
                                  </a>
                                ))}
                          </div>
                        </td>
                      );
                    }
                    const { mark, text, tone, swatch, meter, hint } = cellFor(row, car);
                    return (
                      <td
                        key={car.id}
                        className={`${tone === 'empty' ? 'empty' : ''} ${isSold(car) ? 'sold' : ''}`}
                      >
                        <div className="cell">
                          {swatch && (
                            <span
                              className={`swatch ${swatch.metallic ? 'metallic' : ''}`}
                              style={{ '--paint': swatch.color }}
                            />
                          )}
                          {mark && <span className={`mark ${tone}`}>{mark}</span>}
                          {mark && text ? ' ' : ''}
                          {text}
                          {hint && (
                            <span className="hint" title={hint} aria-label="Aufschlüsselung">
                              ⓘ
                            </span>
                          )}
                          {meter && (
                            <span className={`meter ${meter.zone}`} title={meter.hint}>
                              <span className="meter-fill" style={{ width: `${meter.fill * 100}%` }} />
                              <span className="meter-target" style={{ left: `${meter.target * 100}%` }} />
                              {meter.warn !== null && (
                                <span
                                  className="meter-target warn"
                                  style={{ left: `${meter.warn * 100}%` }}
                                />
                              )}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dialog
        className="drawer"
        ref={listDrawer}
        onClose={() => setOpenDrawer(null)}
        onClick={(e) => {
          if (e.target === listDrawer.current) setOpenDrawer(null); // backdrop
        }}
      >
        <header className="drawer-head">
          <strong>Listen</strong>
          <span className="muted">{lists.length}</span>
          <div className="spacer" />
          <button onClick={newFilter} title="Eine neue, leere Liste anlegen">
            + Neue Liste
          </button>
          <button onClick={() => setOpenDrawer(null)} title="Schließen">
            ✕
          </button>
        </header>
        {builderOpen && (
        <form
          className="filter-builder"
          onSubmit={(e) => {
            e.preventDefault();
            saveFilter(filterName, draftRules);
          }}
        >
          <div className="filter-builder-head">
            <input
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
              placeholder="z. B. Diesel unter 30k"
              aria-label="Name des Filters"
            />
            <button type="button" onClick={() => setBuilderOpen(false)} title="Schließen, ohne zu speichern">
              ✕
            </button>
          </div>
          {draftRules.map((rule, i) => (
            <div className="filter-rule" key={i}>
              <select
                value={rule.type}
                onChange={(e) =>
                  setDraftRules((all) =>
                    all.map((r, j) => (j === i ? emptyRule(e.target.value) : r)),
                  )
                }
                aria-label="Feld"
              >
                {RULE_TYPES.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              <select
                value={rule.op}
                onChange={(e) =>
                  setDraftRules((all) =>
                    all.map((r, j) => (j === i ? { ...r, op: e.target.value } : r)),
                  )
                }
                aria-label="Vergleich"
              >
                {rule.type === 'text' && (
                  <>
                    <option value="contains">enthält</option>
                    <option value="not-contains">enthält nicht</option>
                  </>
                )}
                {(rule.type === 'acc' || rule.type === 'ahk' || rule.type === 'msport' || rule.type === 'upholstery') && (
                  <>
                    <option value="has">vorhanden</option>
                    <option value="missing">nicht vorhanden</option>
                  </>
                )}
                {(rule.type === 'fuel' || rule.type === 'condition') && (
                  <>
                    <option value="eq">ist</option>
                    <option value="ne">ist nicht</option>
                  </>
                )}
                {rule.type === 'registration' && (
                  <>
                    <option value="lt">vor</option>
                    <option value="gt">nach</option>
                  </>
                )}
                {(rule.type === 'price' || rule.type === 'mileage') && (
                  <>
                    <option value="lt">unter</option>
                    <option value="gt">über</option>
                  </>
                )}
              </select>
              {rule.type === 'fuel' || rule.type === 'condition' ? (
                <select
                  value={rule.value}
                  onChange={(e) =>
                    setDraftRules((all) =>
                      all.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    )
                  }
                  aria-label="Wert"
                >
                  {(rule.type === 'fuel' ? FUEL_OPTIONS : CONDITION_OPTIONS).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : rule.type === 'acc' || rule.type === 'ahk' || rule.type === 'msport' || rule.type === 'upholstery' ? (
                <span className="filter-rule-novalue" aria-hidden="true" />
              ) : (
                <input
                  value={rule.value}
                  onChange={(e) =>
                    setDraftRules((all) =>
                      all.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    )
                  }
                  placeholder={
                    rule.type === 'text'
                      ? 'z. B. Diesel'
                      : rule.type === 'registration'
                        ? '09/2022'
                        : rule.type === 'price'
                          ? '30000'
                          : '100000'
                  }
                  inputMode={rule.type === 'text' || rule.type === 'registration' ? 'text' : 'numeric'}
                  aria-label="Wert"
                />
              )}
              <button
                type="button"
                className="filter-rule-remove"
                onClick={() => setDraftRules((all) => all.filter((_, j) => j !== i))}
                disabled={draftRules.length === 1}
                title="Regel entfernen"
              >
                ✕
              </button>
            </div>
          ))}
          <div className="filter-builder-actions">
            <button type="button" onClick={() => setDraftRules((all) => [...all, emptyRule()])}>
              + Regel
            </button>
            <button type="submit" disabled={!filterName.trim() || !draftRules.some(ruleIsValid)}>
              Filter speichern
            </button>
          </div>
        </form>
        )}
        <ul className="drawer-list">
          {/* Pinned, not stored -- "Alle" is just visibleIds spelled out as a
              list, so it always exists and never goes stale on its own. */}
          <li>
            <div className={`list-row ${sameAsSelection(visibleIds) ? 'on' : ''}`}>
              <button
                className="list-load"
                onClick={() => setSelected([...visibleIds])}
                title="Alle Fahrzeuge außer den ausgeblendeten anzeigen"
              >
                <span className="list-name">Alle</span>
                <span className="muted">{visibleIds.length}</span>
              </button>
            </div>
          </li>
          {lists.length === 0 && visibleFavourites.length === 0 && removed.length === 0 && (
            <li>
              <p className="drawer-empty muted">
                Noch kein eigener Filter. „+ Neue Liste“ oben lässt sich Regeln zu Preis,
                Kilometerstand oder einem Suchtext (z. B. „Diesel“, „Sportpaket“) zu einem
                benannten Filter kombinieren, der sich automatisch an neu hinzugekommene
                Fahrzeuge anpasst.
              </p>
            </li>
          )}
          {/* The starred cars behave like any other list here. Their two
              buttons act on the stars themselves, which is why they say
              what they do rather than reusing the plain labels. A hidden
              favourite still counts as a favourite (see the dedicated
              Favoriten drawer) -- it just doesn't show or load from here,
              same as everywhere else a hidden car is excluded. */}
          {visibleFavourites.length > 0 && (
              <li>
                <div className={`list-row ${sameAsSelection(visibleFavourites) ? 'on' : ''}`}>
                  <button
                    className="list-load"
                    onClick={() => setSelected([...visibleFavourites])}
                    title="Die Favoriten vergleichen"
                  >
                    <span className="star">★</span>
                    <span className="list-name">Favoriten</span>
                    <span className="muted">{visibleFavourites.length}</span>
                  </button>
                  <button onClick={() => setFavourites([])} title="Alle Sterne entfernen">
                    ✕
                  </button>
                </div>
              </li>
            )}
            {/* Same idea, opposite direction: review what got hidden (manually
                or as sold on load) and restore it, one car or all at once. */}
            {removed.length > 0 && (
              <li>
                <div className={`list-row ${sameAsSelection(removed) ? 'on' : ''}`}>
                  <button
                    className="list-load"
                    onClick={() => setSelected([...removed])}
                    title="Die ausgeblendeten Fahrzeuge zur Kontrolle anzeigen"
                  >
                    <span className="star">🗑</span>
                    <span className="list-name">Ausgeblendet</span>
                    <span className="muted">{removedCars.length}</span>
                  </button>
                  <button onClick={() => setRemoved([])} title="Alle wiederherstellen">
                    ↺
                  </button>
                </div>
              </li>
            )}
            {lists.map((list) => {
              // A filter's matches are recomputed from `visibleCars` (every
              // known car minus the hidden ones) on every render -- that is
              // what makes it react to a scrape run without anyone touching
              // the list, and keeps a hidden car out of every list but
              // "Ausgeblendet" without having to store that anywhere. A plain
              // list carries a fixed `ids` snapshot instead, filtered the
              // same way.
              //
              // Anything else reads as an empty list rather than throwing: an
              // import can carry a shape this build predates, and a crash here
              // takes the whole page down (see ErrorBoundary.jsx).
              const ids = list.rules
                ? filteredIds(visibleCars, list.rules)
                : (list.ids ?? []).filter((id) => !removed.includes(id));
              return (
                <li key={list.name}>
                  <div className={`list-row ${sameAsSelection(ids) ? 'on' : ''}`}>
                    <button
                      className="list-load"
                      onClick={() => {
                        setSelected([...ids]);
                        // A filter's rules go straight into the builder too --
                        // seeing them and changing them is then the same click,
                        // no separate edit button needed.
                        if (list.rules) editFilter(list);
                      }}
                      title={
                        list.rules
                          ? 'Diesen Filter anwenden und zum Bearbeiten öffnen'
                          : 'Diese Liste vergleichen'
                      }
                    >
                      <span className="list-name">
                        {list.name}
                        {list.rules && (
                          <span className="list-filter-summary muted">
                            {summarizeFilter(list.rules)}
                          </span>
                        )}
                      </span>
                      <span className="muted">{ids.length}</span>
                    </button>
                    {!list.rules && (
                      <button
                        onClick={() => saveList(list.name, selectedIds)}
                        disabled={sameAsSelection(list.ids ?? [])}
                        title="Liste auf die aktuelle Auswahl setzen"
                      >
                        Aktualisieren
                      </button>
                    )}
                    <button
                      onClick={() => setLists((all) => all.filter((x) => x.name !== list.name))}
                      title="Liste löschen"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
      </dialog>

      <dialog
        className="drawer"
        ref={rowDrawer}
        onClose={() => setOpenDrawer(null)}
        onClick={(e) => {
          if (e.target === rowDrawer.current) setOpenDrawer(null); // backdrop
        }}
      >
        <header className="drawer-head">
          <strong>Zeilen</strong>
          <span className="muted">
            {allRows.length - hiddenKeys.length} von {allRows.length}
          </span>
          <div className="spacer" />
          <button onClick={() => setHiddenKeys([])}>Alle</button>
          <button onClick={() => setHiddenKeys(allRows.map((r) => r.key))}>Keine</button>
          <button
            onClick={() => setOrder([])}
            disabled={order.length === 0}
            title="Reihenfolge zurücksetzen"
          >
            ↺
          </button>
          <button onClick={() => setOpenDrawer(null)} title="Schließen">
            ✕
          </button>
        </header>
        <ul className="drawer-list">
          {orderedRows.map((row) => {
            const on = !hidden.has(row.key);
            return (
              <li key={row.key}>
                <label className={`row-option ${on ? 'on' : ''}`} title={row.label}>
                  <input type="checkbox" checked={on} onChange={() => toggleRow(row.key)} />
                  <span className="row-option-label">{row.label}</span>
                  {row.kind === 'feature' && <span className="muted">Ausstattung</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </dialog>
    </div>
  );
}
