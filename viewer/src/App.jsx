import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { buildRows, carLabel, carRef, carSubline, photo, rowDiffers } from './rows.js';

const key = (name) => `car-compare/${name}`;

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
  const [error, setError] = useState(null);
  // Every view setting is persisted, so a reload after `pnpm scrape` lands on
  // the same comparison. null selection = "nothing picked yet" -> show all.
  const [selected, setSelected] = useLocalStorage(key('selected'), null);
  const [order, setOrder] = useLocalStorage(key('order'), []);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(key('hidden'), []);
  const [diffOnly, setDiffOnly] = useLocalStorage(key('diff-only'), false);
  const [featuresOnly, setFeaturesOnly] = useLocalStorage(key('features-only'), false);
  const [dragKey, setDragKey] = useState(null);
  const [openDrawer, setOpenDrawer] = useState(null); // 'cars' | 'rows' | null
  const carDrawer = useDrawer(openDrawer === 'cars');
  const rowDrawer = useDrawer(openDrawer === 'rows');

  const load = useCallback(() => {
    fetch('/api/cars')
      .then((res) => res.json())
      .then((data) => {
        const sorted = [...data.cars].sort((a, b) => (a.price?.gross ?? 0) - (b.price?.gross ?? 0));
        setCars(sorted);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(load, [load]);

  const selectedIds = useMemo(() => {
    if (!cars) return [];
    if (selected === null) return cars.map((c) => c.id);
    return cars.filter((c) => selected.includes(c.id)).map((c) => c.id);
  }, [cars, selected]);

  const shown = useMemo(
    () => (cars ?? []).filter((c) => selectedIds.includes(c.id)),
    [cars, selectedIds],
  );

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
        <button onClick={load}>Neu laden</button>
      </header>

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
        <ul className="drawer-list">
          {cars.map((car) => {
            const active = selectedIds.includes(car.id);
            return (
              <li key={car.id}>
                <label
                  className={`car-option ${active ? 'on' : ''}`}
                  title={`${carRef(car)} ${carLabel(car)}`.trim()}
                >
                  <input type="checkbox" checked={active} onChange={() => toggleCar(car.id)} />
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
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
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
                  <th key={car.id}>
                    {car.images?.[0] && (
                      <img
                        className="hero"
                        src={photo(car.images[0], 'mo-1024')}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    )}
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
                    <span className="price">{car.price?.localized ?? '—'}</span>
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
                    const value = row.value(car);
                    return (
                      <td key={car.id} className={value ? '' : 'empty'}>
                        <div className="cell">{value ?? '–'}</div>
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
