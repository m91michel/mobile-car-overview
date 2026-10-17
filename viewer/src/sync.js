// Keeps favourites, lists, notes, status and the Effektivpreis settings in step with the shared copy
// behind /api/settings, so a second machine or browser sees the same ones --
// for the cars and for every other collection (Kitas, Kinderwagen, ...).
//
// Two documents on the server, one sync for the user. The cars keep the
// document they always had, under the bare names (`notes`). Every other
// collection's settings (`kitas/notes`) live in a second document,
// `?scope=collections`. They could share one, but a build from before
// collections only knows the bare names and PUTs the whole document back:
// an open tab or an installed app that has not reloaded yet would wipe every
// Kita note on its next sync. It never asks for the second document, so it
// cannot touch it.
//
// Off until a sync key is entered. localStorage stays the working copy: every
// hook keeps reading and writing it as before, and this module sits beside
// them -- it pushes after a local write and pulls on load, on focus and once a
// minute. Offline, edits simply wait in localStorage until the next round.
//
// Conflicts are settled by a three-way merge against `base`, the last state
// both sides agreed on. Whatever only one side changed since then is taken from
// that side; only a setting both changed goes to this browser. Notes and
// status are merged per car, so a note typed on the laptop and another typed
// on the phone both survive.
//
// Connecting for the first time has no base, so nothing can be decided
// automatically. `diffForConnect` lists every difference and the sync dialog
// lets you pick a side for each one -- per car for notes and status.

import { PREFIX, key, readSettings } from './settings.js';

// Deliberately outside `car-compare/`: the key and the base must not travel
// along in a settings export, and must not sync themselves.
const TOKEN = 'car-compare-sync/token';

const DEBOUNCE_MS = 1500;
const POLL_MS = 60_000;

/** Settings compared per car (or per Kita) on connect instead of as one block. */
export const PER_ENTRY = ['notes', 'status'];

export const LABELS = {
  favourites: 'Favoriten',
  lists: 'Listen',
  notes: 'Notizen',
  status: 'Status',
  // The Effektivpreis settings. One object, merged per knob like notes are per
  // car, so a bonus switched on here and a rate changed there both survive.
  pricing: 'Preisanpassung',
};

/**
 * What travels. Only the judgements about the items and how to price them: which car is open, which list
 * is shown, sorting and the table/map switch stay with the tab you are in
 * (useTabStorage.js), so two windows can show two different comparisons.
 */
export const SYNCED = Object.keys(LABELS);

/** "kitas/notes" -> { collection: 'kitas', setting: 'notes' }; "notes" -> the cars. */
export const splitName = (name) => {
  const at = name.lastIndexOf('/');
  return at === -1
    ? { collection: null, setting: name }
    : { collection: name.slice(0, at), setting: name.slice(at + 1) };
};

// The Preisanpassung exists for the cars only, so it does not travel per collection.
const COLLECTION_SETTING = /^[a-z0-9][a-z0-9-]*\/(favourites|lists|notes|status)$/;

/** The two server documents and which settings each one holds. */
const DOCS = [
  { scope: null, base: 'car-compare-sync/base', owns: (name) => SYNCED.includes(name) },
  {
    scope: 'collections',
    base: 'car-compare-sync/base/collections',
    owns: (name) => COLLECTION_SETTING.test(name),
  },
];

export const isSynced = (name) => DOCS.some((doc) => doc.owns(name));

/** Just the synced settings out of a full settings object. */
export const pick = (settings, owns = isSynced) =>
  Object.fromEntries(Object.entries(settings ?? {}).filter(([k, v]) => v !== undefined && owns(k)));

export const readLocal = (owns = isSynced) => pick(readSettings(), owns);

// --- comparison and merge ---------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON with sorted object keys, so equal values compare equal as strings. */
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );

export const same = (a, b) => stable(a) === stable(b);

/** Pick per key: unchanged on one side means the other side's change wins. */
function mergeKeys(base, local, remote, mergeValue) {
  const out = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
    const value = mergeValue(base[k], local[k], remote[k]);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function mergeValue(b, l, r) {
  if (same(l, b)) return r;
  if (same(r, b)) return l;
  // Both changed. Objects (notes, status, pricing) are merged one level down,
  // so different cars edited on different devices do not collide.
  if (isPlainObject(l) && isPlainObject(r)) {
    return mergeKeys(isPlainObject(b) ? b : {}, l, r, (eb, el, er) => (same(el, eb) ? er : el));
  }
  return l;
}

export const merge3 = (base, local, remote) => mergeKeys(base, local, remote, mergeValue);

/**
 * Every difference between this browser and the server, for the connect
 * dialog. One item per setting, or per car for PER_ENTRY settings.
 */
export function diffForConnect(local, remote) {
  const items = [];
  for (const name of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[name];
    const r = remote[name];
    if (same(l, r)) continue;
    if (PER_ENTRY.includes(splitName(name).setting) && (l === undefined || isPlainObject(l)) && (r === undefined || isPlainObject(r))) {
      const lo = l ?? {};
      const ro = r ?? {};
      for (const entry of new Set([...Object.keys(lo), ...Object.keys(ro)])) {
        if (!same(lo[entry], ro[entry])) items.push({ name, entry, local: lo[entry], remote: ro[entry] });
      }
    } else {
      items.push({ name, local: l, remote: r });
    }
  }
  return items;
}

export const itemId = (item) => (item.entry === undefined ? item.name : `${item.name}\u0000${item.entry}`);

/** The server state with every item chosen as 'local' taken from this browser. */
export function resolveConnect(local, remote, items, choices) {
  const out = structuredClone(remote);
  for (const item of items) {
    if (choices[itemId(item)] !== 'local') continue;
    if (item.entry === undefined) {
      if (item.local === undefined) delete out[item.name];
      else out[item.name] = item.local;
    } else {
      const map = { ...(isPlainObject(out[item.name]) ? out[item.name] : {}) };
      if (item.local === undefined) delete map[item.entry];
      else map[item.entry] = item.local;
      out[item.name] = map;
    }
  }
  return out;
}

// --- server ------------------------------------------------------------------

export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, token, body, doc = DOCS[0]) {
  let res;
  try {
    res = await fetch(doc.scope ? `/api/settings?scope=${doc.scope}` : '/api/settings', {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SyncError('offline', 0);
  }
  const data = await res.json().catch(() => ({}));
  // The server may still hold keys an earlier build synced (view state and
  // the like). They are ignored here and dropped with the next write.
  if (data.settings) data.settings = pick(data.settings, doc.owns);
  if (res.status === 409) return { conflict: true, ...data };
  if (!res.ok) throw new SyncError(data.error || `Server antwortet mit ${res.status}.`, res.status);
  return data;
}

/**
 * Both documents, read as one: the connect dialog shows the differences of
 * all collections together. `revs` keeps each document's revision for the
 * write that follows.
 */
export async function fetchRemote(token) {
  const parts = [];
  for (const doc of DOCS) parts.push(await request('GET', token, undefined, doc));
  return {
    revs: parts.map((part) => part.rev),
    empty: parts.every((part) => part.rev === 0),
    settings: Object.assign({}, ...parts.map((part) => part.settings)),
  };
}

// --- state -------------------------------------------------------------------

export const getToken = () => localStorage.getItem(TOKEN);

const readBase = (doc) => {
  try {
    const base = JSON.parse(localStorage.getItem(doc.base)) ?? { rev: 0, settings: {} };
    return { ...base, settings: pick(base.settings, doc.owns) };
  } catch {
    return { rev: 0, settings: {} };
  }
};
const writeBase = (doc, rev, settings) =>
  localStorage.setItem(doc.base, JSON.stringify({ rev, settings: pick(settings, doc.owns) }));

// A tiny store for the status line, read with useSyncExternalStore.
let status = { state: getToken() ? 'idle' : 'off', message: null, at: null };
const listeners = new Set();
const setStatus = (patch) => {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn());
};
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getStatus = () => status;

// Set while this module writes localStorage itself, so its own write does not
// count as a local edit that needs pushing.
let applying = false;
const applyLocal = (settings, owns = isSynced) => {
  applying = true;
  try {
    // Every synced name either side has: a setting the merge dropped must go
    // from localStorage too.
    const names = new Set([...Object.keys(pick(settings, owns)), ...Object.keys(readLocal(owns))]);
    for (const name of names) {
      const full = key(name);
      if (settings[name] === undefined) localStorage.removeItem(full);
      else localStorage.setItem(full, JSON.stringify(settings[name]));
      // One event per key, so the useLocalStorage hooks re-read these
      // and nothing else.
      window.dispatchEvent(new StorageEvent('local-storage', { key: full }));
    }
  } finally {
    applying = false;
  }
};

// --- the sync round ----------------------------------------------------------

let running = false;
let again = false;
let timer = null;

export async function syncNow() {
  const token = getToken();
  if (!token) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  setStatus({ state: 'syncing' });
  try {
    // Each document on its own: own base, own revision. A 409 means another
    // device wrote between our read and our write: pull again and re-merge.
    // Three rounds is plenty for two or three devices.
    for (const doc of DOCS) {
      for (let round = 0; round < 3; round++) {
        const base = readBase(doc);
        const remote = await request('GET', token, undefined, doc);
        const local = readLocal(doc.owns);
        const merged = remote.rev === base.rev ? local : merge3(base.settings, local, remote.settings);
        if (!same(merged, local)) applyLocal(merged, doc.owns);
        if (same(merged, remote.settings)) {
          writeBase(doc, remote.rev, merged);
          break;
        }
        const put = await request('PUT', token, { baseRev: remote.rev, settings: merged }, doc);
        if (put.conflict) continue;
        writeBase(doc, put.rev, merged);
        break;
      }
    }
    setStatus({ state: 'ok', message: null, at: new Date() });
  } catch (err) {
    setStatus(
      err.status === 0
        ? { state: 'offline', message: 'offline, Änderungen bleiben lokal' }
        : { state: 'error', message: err.message },
    );
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(0);
    }
  }
}

function schedule(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

let started = false;

/** Wire up the triggers once per page. Harmless while sync is off. */
export function startSync() {
  if (started) return;
  started = true;
  // usehooks-ts announces each of its writes with this event.
  window.addEventListener('local-storage', (event) => {
    if (applying) return;
    // No key means every setting changed at once (a settings import).
    if (event.key && !(event.key.startsWith(PREFIX) && isSynced(event.key.slice(PREFIX.length)))) return;
    schedule();
  });
  window.addEventListener('online', () => schedule(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, POLL_MS);
  schedule(0);
}

/**
 * Finish the connect dialog: take `settings` as the agreed state on both
 * sides, then keep syncing. `remote` is the server state the choices were made
 * against; if it moved on in the meantime, the write is refused.
 */
export async function connect(token, remote, settings) {
  const revs = [];
  for (const [i, doc] of DOCS.entries()) {
    const mine = pick(settings, doc.owns);
    let rev = remote.revs[i];
    if (!same(mine, pick(remote.settings, doc.owns))) {
      const put = await request('PUT', token, { baseRev: rev, settings: mine }, doc);
      if (put.conflict) throw new SyncError('Der Server wurde währenddessen geändert. Bitte erneut verbinden.', 409);
      rev = put.rev;
    }
    revs.push(rev);
  }
  applyLocal(settings);
  localStorage.setItem(TOKEN, token);
  DOCS.forEach((doc, i) => writeBase(doc, revs[i], settings));
  setStatus({ state: 'ok', message: null, at: new Date() });
  startSync();
}

/** Stop syncing. The settings stay in this browser as they are. */
export function disconnect() {
  clearTimeout(timer);
  localStorage.removeItem(TOKEN);
  for (const doc of DOCS) localStorage.removeItem(doc.base);
  setStatus({ state: 'off', message: null, at: null });
}
