// Export and import of the viewer's own state.
//
// Everything the viewer knows that is not scraped -- which cars are selected,
// the row order, hidden rows, favourites, named lists, notes and per-car status
// -- lives in localStorage. That is per browser and per origin, so a second
// instance (another machine, another browser, the deployed build instead of the
// dev server) starts empty and there is no way to carry a setup across. Hence a
// settings file.

export const PREFIX = 'car-compare/';

/** The localStorage key for one setting, e.g. key('favourites'). */
export const key = (name) => `${PREFIX}${name}`;

export const FORMAT = 'car-compare-settings';
export const VERSION = 1;

/**
 * Collected by prefix rather than from a hand-kept list of names. More than one
 * session works on this viewer, so a list would silently go stale the first
 * time somebody adds a `useLocalStorage` and forgets to register it -- and a
 * setting missing from an export is invisible until the import lands.
 */
const names = () => {
  const found = [];
  for (let i = 0; i < localStorage.length; i++) {
    const full = localStorage.key(i);
    if (full?.startsWith(PREFIX)) found.push(full.slice(PREFIX.length));
  }
  return found;
};

/**
 * The current settings as a plain object, ready to be written as JSON.
 *
 * Values are parsed rather than kept as the raw strings localStorage holds, so
 * the file reads (and can be edited) as ordinary JSON instead of as JSON
 * escaped inside JSON. `useLocalStorage` always writes `JSON.stringify`, so
 * anything that fails to parse was not written by the viewer and is skipped.
 */
export function readSettings() {
  const settings = {};
  for (const name of names()) {
    try {
      settings[name] = JSON.parse(localStorage.getItem(key(name)));
    } catch {
      // Not ours, or hand-edited into something invalid. Leave it behind.
    }
  }
  return settings;
}

export function exportSettings() {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: readSettings(),
  };
}

/**
 * Replace every stored setting with `settings`. Shared by the file import and
 * the sync (sync.js), which both mean "this is the setup now".
 */
export function writeSettings(settings) {
  for (const name of names()) localStorage.removeItem(key(name));
  for (const [name, value] of Object.entries(settings)) {
    localStorage.setItem(key(name), JSON.stringify(value));
  }

  // usehooks-ts re-reads on its own "local-storage" event and, with no key on
  // the event, every hook re-reads. So the table updates in place and no page
  // reload is needed -- which also keeps a "geladen" message on screen.
  window.dispatchEvent(new StorageEvent('local-storage'));
}

/**
 * Write a settings file back into localStorage. Throws with a message meant to
 * be shown when the file is not one of ours.
 *
 * **Replaces rather than merges.** An import is supposed to reproduce the setup
 * it came from; merging would leave the target browser's own hidden rows or
 * favourites in place, and the result would be neither setup.
 *
 * Returns the number of settings written.
 */
export function importSettings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Die Datei ist kein gültiges JSON.');
  }
  if (parsed?.format !== FORMAT) {
    throw new Error('Das ist keine Einstellungsdatei des Fahrzeugvergleichs.');
  }
  if (typeof parsed.version === 'number' && parsed.version > VERSION) {
    throw new Error(`Die Datei ist Version ${parsed.version}, dieser Viewer kennt nur ${VERSION}.`);
  }
  const settings = parsed.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Die Datei enthält kein settings-Objekt.');
  }

  writeSettings(settings);
  return Object.keys(settings).length;
}

/** Hand a generated file to the browser. Shared by both exports. */
export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Today, for file names: 2026-08-28. */
export const today = () => new Date().toISOString().slice(0, 10);
