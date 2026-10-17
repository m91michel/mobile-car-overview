import { useCallback, useEffect, useMemo, useState } from 'react';
import App from './App.jsx';
import { resolveCollection, useRoute } from './collections.js';
import { photo } from './rows.js';

/** The start page: one card per folder under data/ that has a collection.json. */
function Home({ collections }) {
  return (
    <div className="home">
      <header className="home-head">
        <h1>Vergleich</h1>
        <p className="muted">Was willst du vergleichen?</p>
      </header>
      <ul className="home-grid">
        {collections.map((collection) => (
          <li key={collection.id}>
            <a className="home-card" href={`#/${collection.id}`}>
              <span className="home-covers" aria-hidden="true">
                {collection.covers?.length ? (
                  collection.covers.map((url) => (
                    <img key={url} src={photo(url, 'mo-360')} alt="" referrerPolicy="no-referrer" />
                  ))
                ) : (
                  <span className="home-icon">{collection.icon ?? '📋'}</span>
                )}
              </span>
              <span className="home-card-text">
                <strong>
                  {collection.icon && collection.covers?.length ? `${collection.icon} ` : ''}
                  {collection.name}
                </strong>
                <span className="muted">
                  {collection.count} {collection.count === 1 ? collection.item ?? 'Eintrag' : collection.items ?? 'Einträge'}
                </span>
                {collection.description && (
                  <span className="home-card-desc muted">{collection.description}</span>
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="home-hint muted">
        Neue Sammlung: einen Ordner <code>data/&lt;name&gt;/</code> mit einer{' '}
        <code>collection.json</code> und einem Unterordner <code>listings/</code> anlegen, eine
        JSON-Datei pro Eintrag. Die Tabelle baut sich aus den Fakten und Merkmalen der Einträge
        von selbst.
      </p>
    </div>
  );
}

export default function Root() {
  const route = useRoute();
  const [collections, setCollections] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetch('/api/collections.json')
      .then((res) => res.json())
      .then((data) => {
        setCollections(data.collections);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(load, [load]);

  const meta = collections?.find((c) => c.id === route);
  // Stable per collection, since App memoizes its rows on it.
  const collection = useMemo(() => (meta ? resolveCollection(meta) : null), [meta]);

  useEffect(() => {
    document.title = meta ? `${meta.name} – Vergleich` : 'Vergleich';
  }, [meta]);

  if (error) return <p className="notice">Sammlungen konnten nicht geladen werden: {error}</p>;
  if (!collections) return <p className="notice">Lade…</p>;
  if (collections.length === 0)
    return (
      <p className="notice">
        Keine Sammlung gefunden. Jede braucht einen Ordner <code>data/&lt;name&gt;/</code> mit
        einer <code>collection.json</code>.
      </p>
    );
  if (!meta) return <Home collections={collections} />;
  // Keyed by id, so switching collections starts a fresh App: every piece of
  // state, and every storage key, belongs to exactly one collection.
  return <App key={meta.id} collection={collection} />;
}
