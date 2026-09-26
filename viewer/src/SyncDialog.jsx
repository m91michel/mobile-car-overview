import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { carLabel, carRef, STATUSES } from './rows.js';
import {
  LABELS,
  connect,
  diffForConnect,
  disconnect,
  fetchRemote,
  readLocal,
  getStatus,
  itemId,
  resolveConnect,
  subscribe,
  syncNow,
} from './sync.js';

export const useSyncStatus = () => useSyncExternalStore(subscribe, getStatus);

const time = (date) => date?.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** One line for the ⚙ menu. */
export function syncSummary(status) {
  if (status.state === 'off') return 'aus';
  if (status.state === 'syncing') return 'läuft…';
  if (status.state === 'ok') return `✓ ${time(status.at)}`;
  if (status.state === 'offline') return 'offline';
  if (status.state === 'error') return '⚠ Fehler';
  return 'an';
}

const truncate = (text, n = 160) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** What one side of a difference holds, in words rather than JSON. */
function preview(name, value, carName) {
  if (value === undefined) return '— nicht vorhanden';
  if (name === 'notes') {
    const parts = [value.note && truncate(value.note), value.links?.length && `${value.links.length} Link(s)`];
    const text = parts.filter(Boolean).join(' · ') || '(leer)';
    return value.updatedAt ? `${text} — ${new Date(value.updatedAt).toLocaleString('de-DE')}` : text;
  }
  if (name === 'status') return STATUSES.find((s) => s.key === value)?.label ?? String(value);
  if (typeof value === 'boolean') return value ? 'an' : 'aus';
  if (value === null) return '(nichts gewählt)';
  if (Array.isArray(value)) {
    if (name === 'lists') return value.map((l) => l?.name).filter(Boolean).join(', ') || '(keine)';
    if (['favourites', 'removed', 'selected'].includes(name)) {
      return `${value.length}: ${truncate(value.map(carName).join(', '), 200)}`;
    }
    return `${value.length} Einträge`;
  }
  if (typeof value === 'object') {
    return truncate(Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(', '), 200);
  }
  return String(value);
}

/**
 * Turning sync on, and deciding what survives when this browser and the server
 * disagree. Every difference is listed -- per car for notes and status -- and
 * each gets its own choice, so the laptop's notes can win while the phone's
 * favourites do.
 */
export default function SyncDialog({ cars, onClose, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const status = useSyncStatus();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set once the server answered and there are differences to decide.
  const [pending, setPending] = useState(null); // { token, remote, local, items }
  const [choices, setChoices] = useState({});

  const byId = useMemo(() => new Map((cars ?? []).map((c) => [c.id, c])), [cars]);
  const carName = (id) => {
    const car = byId.get(id);
    return car ? `${carRef(car)} ${carLabel(car)}`.trim() : id;
  };
  const shortName = (id) => (byId.get(id) ? carRef(byId.get(id)) || id : id);

  const finish = async (key, remote, settings, message) => {
    await connect(key, remote, settings);
    onDone(message);
  };

  const start = async (event) => {
    event.preventDefault();
    const key = token.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const remote = await fetchRemote(key);
      const local = readLocal();
      if (remote.rev === 0) {
        await finish(key, remote, local, 'Sync an. Der Server war leer, dieser Browser wurde hochgeladen.');
        return;
      }
      const items = diffForConnect(local, remote.settings);
      if (items.length === 0) {
        await finish(key, remote, remote.settings, 'Sync an. Browser und Server waren schon gleich.');
        return;
      }
      setChoices(Object.fromEntries(items.map((item) => [itemId(item), 'remote'])));
      setPending({ token: key, remote, local, items });
    } catch (err) {
      setError(err.status === 0 ? 'Server nicht erreichbar.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token: key, remote, local, items } = pending;
      const taken = items.filter((item) => choices[itemId(item)] === 'local').length;
      await finish(
        key,
        remote,
        resolveConnect(local, remote.settings, items, choices),
        `Sync an. ${taken} von ${items.length} Unterschieden aus diesem Browser übernommen.`,
      );
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const setAll = (side, name) =>
    setChoices((current) =>
      Object.fromEntries(
        pending.items.map((item) => [
          itemId(item),
          name === undefined || item.name === name ? side : current[itemId(item)],
        ]),
      ),
    );

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of pending?.items ?? []) {
      if (!map.has(item.name)) map.set(item.name, []);
      map.get(item.name).push(item);
    }
    return [...map];
  }, [pending]);

  const connected = status.state !== 'off';

  return (
    <dialog
      className="editor sync-dialog"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="drawer-head">
        <strong>Sync</strong>
        <span className="muted">Einstellungen und Notizen geräteübergreifend</span>
        <div className="spacer" />
        <button onClick={onClose} title="Schließen">
          ✕
        </button>
      </header>

      {connected && !pending && (
        <>
          <div className="editor-body">
            <p>
              Sync ist an.{' '}
              {status.state === 'ok' && `Zuletzt abgeglichen um ${time(status.at)}.`}
              {status.state === 'syncing' && 'Gleicht gerade ab…'}
              {status.state === 'idle' && 'Wartet auf den ersten Abgleich.'}
            </p>
            {status.message && <p className="sync-error">{status.message}</p>}
            <p className="muted">
              Änderungen gehen nach ein bis zwei Sekunden an den Server. Andere Geräte holen sie beim
              Öffnen, beim Zurückwechseln in den Tab und einmal pro Minute ab.
            </p>
          </div>
          <footer className="editor-foot">
            <button
              onClick={() => {
                if (window.confirm('Sync trennen? Die Einstellungen bleiben in diesem Browser, werden aber nicht mehr abgeglichen.')) {
                  disconnect();
                }
              }}
            >
              Trennen
            </button>
            <button onClick={syncNow}>Jetzt abgleichen</button>
            <button className="primary" onClick={onClose}>
              Fertig
            </button>
          </footer>
        </>
      )}

      {!connected && !pending && (
        <form onSubmit={start}>
          <div className="editor-body">
            <p className="muted">
              Ohne Schlüssel bleibt alles nur in diesem Browser. Mit Schlüssel gleicht der Viewer Favoriten,
              Listen, Notizen und Status mit dem Server ab. Welche Autos und welche Liste offen sind,
              bleibt pro Tab. Beim ersten Verbinden wählst du bei jedem Unterschied, welcher Stand gilt.
            </p>
            <label className="field">
              <span className="muted">Sync-Schlüssel</span>
              <input
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </label>
            {error && <p className="sync-error">{error}</p>}
          </div>
          <footer className="editor-foot">
            <button type="button" onClick={onClose}>
              Abbrechen
            </button>
            <button className="primary" type="submit" disabled={busy || !token.trim()}>
              {busy ? 'Verbinde…' : 'Verbinden'}
            </button>
          </footer>
        </form>
      )}

      {pending && (
        <>
          <div className="editor-body sync-choices">
            <p>
              Server und dieser Browser unterscheiden sich in <strong>{pending.items.length}</strong>{' '}
              Punkten. Wähle bei jedem, welcher Stand gilt.
            </p>
            <div className="sync-all">
              <button onClick={() => setAll('remote')}>Alles vom Server</button>
              <button onClick={() => setAll('local')}>Alles aus diesem Browser</button>
            </div>
            {groups.map(([name, items]) => (
              <section key={name} className="sync-group">
                <header>
                  <strong>{LABELS[name] ?? name}</strong>
                  {items.length > 1 && (
                    <span className="sync-group-all">
                      <button onClick={() => setAll('remote', name)}>alle Server</button>
                      <button onClick={() => setAll('local', name)}>alle Browser</button>
                    </span>
                  )}
                </header>
                {items.map((item) => {
                  const id = itemId(item);
                  return (
                    <div key={id} className="sync-item">
                      {item.entry !== undefined && <div className="sync-item-name">{carName(item.entry)}</div>}
                      {['local', 'remote'].map((side) => (
                        <label key={side} className={`sync-side ${choices[id] === side ? 'on' : ''}`}>
                          <input
                            type="radio"
                            name={id}
                            checked={choices[id] === side}
                            onChange={() => setChoices((c) => ({ ...c, [id]: side }))}
                          />
                          <span>
                            <span className="muted">{side === 'local' ? 'Dieser Browser' : 'Server'}</span>
                            <br />
                            {preview(item.name, item[side], shortName)}
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </section>
            ))}
            {error && <p className="sync-error">{error}</p>}
          </div>
          <footer className="editor-foot">
            <button onClick={() => setPending(null)}>Zurück</button>
            <button className="primary" onClick={apply} disabled={busy}>
              {busy ? 'Übernehme…' : 'Übernehmen und Sync starten'}
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
