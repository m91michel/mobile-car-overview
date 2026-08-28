import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import {
  SORTS,
  STATUSES,
  buildRows,
  carLabel,
  carRef,
  carSubline,
  isSold,
  photo,
  rowDiffers,
  sortCars,
  toCsv,
} from './rows.js';
import { cellFor } from './wishlist.js';
import { download, exportSettings, importSettings, key, today } from './settings.js';
import { DEFAULT_PRICING, applyPricingSettings } from './pricing.js';

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
 * The Effektivpreis's mileage/facelift knobs, per browser via localStorage
 * (car-compare/pricing) rather than the data/assessment.json server default
 * -- so two people comparing the same 47 cars can each weigh mileage or the
 * facelift gap the way they personally would.
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
        <span className="muted">wirkt auf den Effektivpreis, nur in diesem Browser</span>
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
            checked={pricing.lciMalusEnabled}
            onChange={(e) => onChange({ lciMalusEnabled: e.target.checked })}
          />
          Malus für Fahrzeuge ohne Facelift (vor LCI)
        </label>
        <label className="field">
          <span className="muted">Facelift-Malus (€)</span>
          <input
            type="number"
            min="0"
            step="50"
            disabled={!pricing.lciMalusEnabled}
            value={pricing.lciMalus}
            onChange={num('lciMalus')}
          />
        </label>
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

function CarOption({ car, active, onToggle, favourite, onFavourite }) {
  return (
    <label
      className={`car-option ${active ? 'on' : ''} ${isSold(car) ? 'sold' : ''}`}
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
        </span>
      </span>
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
  const [selected, setSelected] = useLocalStorage(key('selected'), null);
  const [order, setOrder] = useLocalStorage(key('order'), []);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(key('hidden'), []);
  const [diffOnly, setDiffOnly] = useLocalStorage(key('diff-only'), false);
  const [featuresOnly, setFeaturesOnly] = useLocalStorage(key('features-only'), false);
  // Two independent orders: the drawer is for finding a car, the columns are
  // for reading the comparison, and those want different sorts.
  const [listSort, setListSort] = useLocalStorage(key('sort-list'), 'ref');
  const [listDesc, setListDesc] = useLocalStorage(key('sort-list-desc'), false);
  const [columnSort, setColumnSort] = useLocalStorage(key('sort-columns'), 'price');
  const [columnDesc, setColumnDesc] = useLocalStorage(key('sort-columns-desc'), false);
  // A shortlist you keep while working through the field, independent of which
  // cars happen to be in the table right now.
  const [favourites, setFavourites] = useLocalStorage(key('favourites'), []);
  // Named selections, so narrowing the table to a shortlist is not a one-way
  // door back through 30 checkboxes.
  const [lists, setLists] = useLocalStorage(key('lists'), []);
  const [notes, setNotes] = useLocalStorage(key('notes'), {});
  const [statuses, setStatuses] = useLocalStorage(key('status'), {});
  const [favouritesFirst, setFavouritesFirst] = useLocalStorage(key('favourites-first'), false);
  // The Effektivpreis's mileage/facelift knobs -- see PricingSettings above.
  const [pricing, setPricing] = useLocalStorage(key('pricing'), DEFAULT_PRICING);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [dragKey, setDragKey] = useState(null);
  const [openDrawer, setOpenDrawer] = useState(null); // 'cars' | 'favourites' | 'lists' | 'rows'
  const carDrawer = useDrawer(openDrawer === 'cars');
  const favDrawer = useDrawer(openDrawer === 'favourites');
  const listDrawer = useDrawer(openDrawer === 'lists');
  const rowDrawer = useDrawer(openDrawer === 'rows');
  const [listName, setListName] = useState('');
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

  // Re-derives the Effektivpreis with the live pricing settings, overriding
  // the server default baked into data/cars.json (scripts/assessment.mjs).
  const priced = useMemo(
    () => (cars ?? []).map((car) => applyPricingSettings(car, pricing)),
    [cars, pricing],
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

  const selectedIds = useMemo(() => {
    if (!cars) return [];
    if (selected === null) return cars.map((c) => c.id);
    return cars.filter((c) => selected.includes(c.id)).map((c) => c.id);
  }, [cars, selected]);

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
      const base = current ?? (cars ?? []).map((c) => c.id);
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

  const sameAsSelection = (ids) =>
    ids.length === selectedIds.length && ids.every((id) => selectedIds.includes(id));

  const isFavourite = (id) => favourites.includes(id);

  const toggleFavourite = (id) =>
    setFavourites((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const favouriteCars = useMemo(
    () => listCars.filter((car) => favourites.includes(car.id)),
    [listCars, favourites],
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
          Fahrzeuge <strong>{shown.length}</strong>
          <span className="muted">/ {cars.length}</span>
        </button>
        <button className="drawer-open" onClick={() => setOpenDrawer('favourites')}>
          <span className="star">★</span> <strong>{favourites.length}</strong>
        </button>
        <button className="drawer-open" onClick={() => setOpenDrawer('lists')}>
          Listen <strong>{lists.length}</strong>
        </button>
        <button className="drawer-open" onClick={() => setOpenDrawer('rows')}>
          Zeilen <strong>{visibleRows.length}</strong>
          <span className="muted">/ {allRows.length}</span>
        </button>
        <div className="spacer" />
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
        <Menu label="⚙" title="Einstellungen">
          <button onClick={load}>Neu laden</button>
          <button onClick={() => setPricingOpen(true)}>
            Preisanpassung <span className="muted">Effektivpreis</span>
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
          pricing={pricing}
          onChange={(patch) => setPricing((current) => ({ ...current, ...patch }))}
          onReset={() => setPricing(DEFAULT_PRICING)}
          onClose={() => setPricingOpen(false)}
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
          <button onClick={() => setSelected(cars.map((c) => c.id))}>Alle</button>
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
        <ul className="drawer-list">
          {listCars.map((car) => (
            <li key={car.id}>
              <CarOption
                car={car}
                active={selectedIds.includes(car.id)}
                onToggle={() => toggleCar(car.id)}
                favourite={isFavourite(car.id)}
                onFavourite={() => toggleFavourite(car.id)}
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
            onClick={() => setSelected(favouriteCars.map((c) => c.id))}
            disabled={favouriteCars.length === 0}
            title="Nur die Favoriten vergleichen"
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
          <button onClick={() => setOpenDrawer(null)} title="Schließen">
            ✕
          </button>
        </header>
        <form
          className="list-save"
          onSubmit={(e) => {
            e.preventDefault();
            saveList(listName, selectedIds);
          }}
        >
          <input
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            placeholder="z. B. unter 30k"
            aria-label="Name der Liste"
          />
          <button type="submit" disabled={!listName.trim() || shown.length === 0}>
            {shown.length} sichern
          </button>
        </form>
        {lists.length === 0 && favourites.length === 0 ? (
          <p className="drawer-empty muted">
            Noch keine Liste. Die aktuelle Fahrzeugauswahl lässt sich oben unter einem Namen
            ablegen und später mit einem Klick zurückholen.
          </p>
        ) : (
          <ul className="drawer-list">
            {/* The starred cars behave like any other list here. Their two
                buttons act on the stars themselves, which is why they say
                what they do rather than reusing the plain labels. */}
            {favourites.length > 0 && (
              <li>
                <div className={`list-row ${sameAsSelection(favourites) ? 'on' : ''}`}>
                  <button
                    className="list-load"
                    onClick={() => setSelected([...favourites])}
                    title="Die Favoriten vergleichen"
                  >
                    <span className="star">★</span>
                    <span className="list-name">Favoriten</span>
                    <span className="muted">{favourites.length}</span>
                  </button>
                  <button
                    onClick={() => setFavourites([...selectedIds])}
                    disabled={sameAsSelection(favourites)}
                    title="Genau die Fahrzeuge der aktuellen Auswahl mit einem Stern versehen"
                  >
                    Aktualisieren
                  </button>
                  <button onClick={() => setFavourites([])} title="Alle Sterne entfernen">
                    ✕
                  </button>
                </div>
              </li>
            )}
            {lists.map((list) => (
              <li key={list.name}>
                <div className={`list-row ${sameAsSelection(list.ids) ? 'on' : ''}`}>
                  <button
                    className="list-load"
                    onClick={() => setSelected([...list.ids])}
                    title="Diese Liste vergleichen"
                  >
                    <span className="list-name">{list.name}</span>
                    <span className="muted">{list.ids.length}</span>
                  </button>
                  <button
                    onClick={() => saveList(list.name, selectedIds)}
                    disabled={sameAsSelection(list.ids)}
                    title="Liste auf die aktuelle Auswahl setzen"
                  >
                    Aktualisieren
                  </button>
                  <button
                    onClick={() => setLists((all) => all.filter((x) => x.name !== list.name))}
                    title="Liste löschen"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
