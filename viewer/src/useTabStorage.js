import { useCallback, useEffect, useState } from 'react';

// View state that belongs to one tab: which cars are open, table or map,
// sorting. useLocalStorage shares a value across every tab of the browser (it
// listens to the cross-tab `storage` event), so picking a list in one window
// used to switch the other one too.
//
// The value lives in sessionStorage, which is per tab and survives a reload.
// It is mirrored into localStorage as well, for two reasons: a freshly opened
// tab starts from the last view anyone used instead of from nothing, and the
// JSON export (settings.js, collected by prefix) still carries it. Nothing
// listens for another tab's writes, so the mirror never pulls an open tab
// along.

const read = (storage, storageKey) => {
  try {
    const raw = storage.getItem(storageKey);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export function useTabStorage(storageKey, initialValue) {
  const [value, setValue] = useState(
    () => read(sessionStorage, storageKey) ?? read(localStorage, storageKey) ?? initialValue,
  );

  useEffect(() => {
    const raw = JSON.stringify(value);
    sessionStorage.setItem(storageKey, raw);
    localStorage.setItem(storageKey, raw);
  }, [storageKey, value]);

  // A settings import writes localStorage and announces it with a keyless
  // "local-storage" event (settings.js). That one should reach the tab that
  // did the import, unlike the sync's per-key events.
  useEffect(() => {
    const onImport = (event) => {
      if (event.key) return;
      const imported = read(localStorage, storageKey);
      setValue(imported === undefined ? initialValue : imported);
    };
    window.addEventListener('local-storage', onImport);
    return () => window.removeEventListener('local-storage', onImport);
    // initialValue is a literal at every call site; re-subscribing on a new
    // array identity each render would be pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const set = useCallback((next) => setValue((current) => (typeof next === 'function' ? next(current) : next)), []);
  return [value, set];
}
