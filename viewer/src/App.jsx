import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { buildRows, carLabel, carSubline, photo, rowDiffers } from './rows.js';

const key = (name) => `car-compare/${name}`;

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

  const hideRow = (rowKey) => setHiddenKeys((keys) => [...keys, rowKey]);

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
        <span className="muted">
          {shown.length} von {cars.length} Fahrzeugen · {visibleRows.length} Zeilen
        </span>
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
        <button
          onClick={() => {
            setOrder([]);
            setHiddenKeys([]);
          }}
          disabled={order.length === 0 && hiddenKeys.length === 0}
        >
          Zeilen zurücksetzen
        </button>
      </header>

      <section className="picker">
        {cars.map((car) => {
          const active = selectedIds.includes(car.id);
          return (
            <button
              key={car.id}
              className={`chip ${active ? 'on' : ''}`}
              onClick={() => toggleCar(car.id)}
              title={carLabel(car)}
            >
              {car.images?.[0] && (
                <img src={photo(car.images[0], 'mo-240')} alt="" referrerPolicy="no-referrer" />
              )}
              <span className="chip-text">
                <strong>
                  {car.shortTitle || carLabel(car)} <span className="muted">{car.price?.localized ?? '—'}</span>
                </strong>
                <span className="muted">{carSubline(car)}</span>
              </span>
            </button>
          );
        })}
      </section>

      {shown.length === 0 ? (
        <p className="notice">Oben mindestens ein Fahrzeug auswählen.</p>
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
                      title={carLabel(car)}
                    >
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
                        <button onClick={() => hideRow(row.key)} title="Zeile ausblenden">✕</button>
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

      {hiddenKeys.length > 0 && (
        <section className="hidden-rows">
          <span className="muted">Ausgeblendet:</span>
          {hiddenKeys.map((rowKey) => {
            const row = allRows.find((r) => r.key === rowKey);
            return (
              <button
                key={rowKey}
                className="chip small"
                onClick={() => setHiddenKeys((keys) => keys.filter((k) => k !== rowKey))}
              >
                {row?.label ?? rowKey} <span className="muted">+</span>
              </button>
            );
          })}
        </section>
      )}
    </div>
  );
}
