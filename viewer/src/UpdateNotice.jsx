import { useEffect, useState } from 'react';
import './update-notice.css';

// Offers a reload once Vercel serves a newer commit than the one this bundle
// was built from. An open tab, and even more so the installed app, can run an
// old build for days otherwise, since nothing ever reloads it.
//
// Asks /api/health (api/health.js) on load, whenever the tab comes back to the
// front and every five minutes while it is visible. Off on the dev server,
// where hot reload already keeps the page current, and whenever either side
// does not know its version.

const CHECK_MS = 5 * 60_000;
const BUILT = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;

async function deployedVersion() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()).version ?? null;
  } catch {
    return null; // Offline or no endpoint: nothing to report.
  }
}

export default function UpdateNotice() {
  const [available, setAvailable] = useState(null); // the newer commit
  const [dismissed, setDismissed] = useState(null);

  useEffect(() => {
    if (import.meta.env.DEV || !BUILT) return undefined;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const version = await deployedVersion();
      if (version && version !== BUILT) setAvailable(version);
    };
    check();
    const timer = setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  // "Später" hides this one version; a deploy after it asks again.
  if (!available || available === dismissed) return null;

  return (
    <div className="update-notice" role="status">
      <span>
        <strong>Neue Version verfügbar</strong>
        <span className="update-notice-sub">
          {BUILT.slice(0, 7)} → {available.slice(0, 7)}
        </span>
      </span>
      <button onClick={() => setDismissed(available)}>Später</button>
      <button className="primary" onClick={() => window.location.reload()}>
        Neu laden
      </button>
    </div>
  );
}
