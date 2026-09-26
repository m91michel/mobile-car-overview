# car-compare-tool

## Goal

Replace mobile.de's own vehicle comparison page, which is too weak to actually
decide between saved cars. Two parts:

1. **Fetcher** — a script that takes mobile.de listing URLs (or a whole
   `mobile.de/park/compare?id=...&id=...` URL) and writes one normalized JSON
   file per car.
2. **Viewer** — a local UI that compares those JSON files side by side.

The viewer must fix what mobile.de gets wrong:

- **Hide irrelevant features.** Per-feature visibility toggles, so rows for
  equipment that doesn't matter can be removed from the comparison.
- **Sticky title row.** The car names/prices column header stays visible while
  scrolling a long feature list.
- **One table, not two.** Hard facts (mileage, power, first registration) and
  features (Ausstattung) belong in a single scrollable table, not split across
  separate tabs the way mobile.de does it.

## Why the fetcher works this way

mobile.de is behind **Akamai Bot Manager** and has no consumer API.

- `curl` / plain HTTP → **403**, regardless of headers. Detection is on TLS
  fingerprint (JA3/JA4) and IP reputation, not User-Agent.
- Playwright/Puppeteer-launched Chrome (headless *or* headed) → served the
  "Zugriff verweigert" page, because automation flags like
  `navigator.webdriver` are set.
- **Real Chrome + raw Chrome DevTools Protocol → works.** Chrome is started
  normally with `--remote-debugging-port`, so no automation flags are set
  (`navigator.webdriver === false`) and Akamai serves the real page.

That is why `scripts/cdp.mjs` is a hand-rolled CDP client over Node's built-in
`WebSocket` instead of a browser-automation library. **Do not replace it with
Playwright or Puppeteer** — that reintroduces the block.

## Where the data comes from

Listing pages are a Next.js App Router app. The server streams its React Server
Component payload via `self.__next_f.push([1, "<chunk>"])`. Joining those chunks
yields a string containing a complete `"listing":{...}` object with everything:

- `attributes[]` — hard facts as `{label, tag, value}` (~28-32 per car)
- `features[]` — equipment names as plain strings (~60 per car)
- `price` (gross/net/VAT), `priceRating` (`"Guter Preis"` + threshold bands)
- `images[]`, `contact` (dealer, address, rating), `financePlans[]`, `kba`

Parsing this payload is preferred over scraping the rendered DOM, because the
DOM splits the same data across the Details/Ausstattung/Anbieter tabs and lazy
sections.

## Usage

Requires Node >= 22 (the fetcher uses the built-in `WebSocket`) and pnpm.

```bash
pnpm install

pnpm park                     # open mobile.de in the scraper's Chrome; log in once
pnpm saved                    # scrape every car bookmarked in Mein Parkplatz
pnpm refresh                  # re-fetch every car already in data/
pnpm scrape -- 462145366 459175992
pnpm scrape -- 'https://www.mobile.de/park/compare?id=462145366&id=459175992'
pnpm scrape -- --from cars.txt
pnpm dealer -- '<dealer url>' # a car that is only on a dealer's own site
pnpm chrome                   # start the scraping Chrome on its own
pnpm chrome:stop              # shut it down

pnpm viewer                   # compare viewer on http://localhost:5180
```

Quote any URL — the `&` between `id` params would otherwise be swallowed by the
shell. Note that `fetch` is **not** available as a script name: `pnpm fetch` is a
pnpm built-in and would silently run that instead, which is why the command is
called `scrape`.

Output is `data/listings/<id>.json` per car, merged into `data/cars.json`.

### Batch options

| Flag | Meaning |
|---|---|
| `--saved` | read ids from Mein Parkplatz (needs a signed-in profile) |
| `--from <file>` | newline-delimited ids/urls; blank lines and `#` comments ignored |
| `--refresh` | re-fetch every id already in `data/cars.json` |
| `--recheck-sold` | also re-try listings previously recorded as sold |
| `--max-age <hours>` | skip cars fetched more recently than this |
| `--delay <ms>` | pause between listings per worker (default 2500, jittered ±40%) |
| `--retries <n>` | retries per listing (default 2, with backoff) |
| `--cooloff <ms>` | first wait after a bot-block, grows per retry (default 60000) |
| `--via-park` | reach each car by clicking its Parkplatz card, and linger on it |
| `--limit <n>` | stop cleanly after n cars, to spread a refresh over sittings |
| `--concurrency <n>` | parallel tabs (default 1) |

Three things make batch runs bearable:

- **Adaptive waiting.** Instead of sleeping a fixed few seconds per page, the
  fetcher polls a cheap in-page probe (`LISTING_READY_PROBE`) until the RSC
  payload is complete, so fast pages cost what they should.
- **Failures stay local.** A sold or slow listing is retried, then recorded and
  skipped; the run continues and the index is merged rather than replaced.
  Sold-out cars alone do not fail the run's exit code.
- **A block ends the run, it does not fail a car.** See below.

Keep `--concurrency` low (1-3). It drives real tabs in one browser, which is
ordinary behaviour, but a dozen parallel tabs is not.

### What a bot-block looks like, and why the run stops

A 49-listing `--saved --refresh` at a flat 2.5s delay was served
`Zugriff verweigert` on the **41st** page, and the three pages after it were
refused too. So the useful budget is somewhere around 40 detail pages in one
sitting, and it is **volume that gets noticed, not only the gap** — widening
`--delay` alone does not buy an unlimited run.

Three properties follow from that, and they match `pnpm available`, which
learned the same lesson earlier on its own 29-listing run:

- **The delay is jittered ±40%.** A request exactly every 2500ms is a
  metronome, which is precisely what a bot looks like. The mean is unchanged.
- **A blocked listing is re-queued, never recorded.** A block says nothing
  about the car, so it must not land in the failure list where a reader —
  or a future script — could mistake it for a sold listing. It goes back on
  the queue for a later run and keeps the data it already had.
- **Three blocks in a row abandon the whole run.** Past that point mobile.de
  is refusing the session rather than one page, and every further retry only
  digs the hole deeper. Everything fetched before the block is still written
  to `data/` and the index, so the run resumes rather than restarting:

  ```bash
  pnpm scrape -- --saved --refresh --max-age 6   # skips what already landed
  ```

### Looking like a person: `--via-park`

By default the fetcher opens `details.html?id=…` directly, forty times in a
row, with no referrer and no interaction of any kind. `--via-park` instead
loads Mein Parkplatz once and **clicks each car's card**, lingers on the
listing, and goes back to the list — the path a person actually takes.

What it changes, in descending order of how much it is likely to matter:

1. **Interaction telemetry.** Akamai's sensor script collects mouse movement,
   click coordinates, scroll and timing. A session producing none of it while
   pulling dozens of deep links is an obvious outlier. `scripts/cdp.mjs` sends
   real `Input.dispatchMouseEvent`s, not synthesized `MouseEvent`s — a
   script-made event carries `isTrusted === false`, which is trivial to check.
2. **Time on page.** `readListing` scrolls the listing for a handful of
   seconds after the payload is already parsed. It buys nothing technically;
   it is only there so a visit does not end 180ms after the last byte.
3. **The URL and the referrer.** Parkplatz links are
   `…&action=parkItem`, where the direct path invents `action=compareItem` —
   an action nobody performed. Whether the `Referer` survives depends on the
   anchor's `rel`, which has not been checked; if mobile.de sets `noreferrer`
   this point is worth nothing.

**Be honest about what this is.** It is plausible, not measured — an A/B test
would cost real blocks to run, and none has been done. Two things follow:

- **It does not raise the ceiling.** Volume is the lever with a proven
  mechanism: ~40 detail pages got refused regardless of how they were reached.
  Treat `--via-park` as "not worse, probably better", never as permission to
  fetch more. `--limit <n>` plus more than one sitting is the actual fix.
- **It cannot make a run fail.** Every step degrades to direct navigation —
  a missing card (the normal case for a sold car), a click that does not
  navigate, any error on the list page. The one exception is deliberate: a
  **block** on the Parkplatz propagates instead of falling back, because
  retrying as a direct hit while refused only spends budget.

The cards carry `target="_blank"`, so a real click would spawn a tab to chase
and close for each car. `clickParkedCard` strips the attribute and navigates
the current tab instead — the single deviation from what a hand would do, and
much the cheapest.

```bash
pnpm scrape -- --saved --via-park --limit 2 --delay 9000   # try it on two
pnpm scrape -- --saved --via-park --max-age 6              # then the rest
```

Recovering from a block is waiting, not tuning — and the budget comes back
more slowly than the block page goes away. Observed on one evening: blocked on
page 41, still blocked 10 minutes later, a single detail page rendering
normally after ~45 minutes, and then **only four more listings** before the
next block. So a page that loads is not proof the run budget has reset; it
only proves the hard refusal has lifted. Allow hours, not minutes, before
resuming a large refresh.

Two corollaries for testing whether a block has lifted:

- Use a **single detail page**, never a full run.
- Probe it with `AVAILABILITY_PROBE`'s title check, **not**
  `LISTING_READY_PROBE`. Reloading one id repeatedly serves the RSC payload
  from cache without re-pushing `self.__next_f`, so the readiness probe
  reports `pending` on a perfectly live page and reads as a block that is
  still in force. `availability.mjs` documents this; it is easy to walk into
  again when writing a one-off waiter.

**Do not kill a blocked run with Ctrl-C.** The index, the ref registry and the
sold list are all written in one pass at the very end, so killing the process
leaves `data/listings/*.json` updated while `data/cars.json` still shows the old
prices. `pnpm renormalize` rebuilds the index from the listing files and repairs
exactly that, but letting the run abandon itself avoids the problem entirely.

### Mein Parkplatz (bookmarked cars)

The Parkplatz is per-browser when anonymous and synced to your account once you
are signed in. So sign the dedicated profile in **once** with `pnpm park`; after
that `pnpm saved` sees the same bookmarks on every run, and the whole comparison
can be refreshed without pasting URLs.

`scripts/parkplatz.mjs` harvests ids from three places at once — detail links,
the compare-button URL, and the RSC payload — and dedupes, so a markup change in
any one of them does not break the run.

### Cars that are not on mobile.de: `pnpm dealer`

Many BMW dealer sites embed the same stock widget (pixel-base, loaded from
`cdn.dein.auto`; URLs ending in `#!/vehicles/<id>/…` or carrying
`?pxc-view=vehicle-details&vehicle-id=<id>`). `scripts/dealer.mjs`
opens such a page in the scraping Chrome, reads the widget's own
`api.pixel-base.de/…/vehicles/<id>?apikey=…` request back from Resource Timing
(so no key is hard-coded), and maps that JSON onto the mobile.de shape:

- **mobile.de's wording.** pixel-base's feature list is mobile.de's checkbox
  catalogue, served in whatever language the dealer configured (English at
  Wormser, German at Sperber). `FEATURES` is therefore keyed by the
  language-independent `optionId`, and the car joins the existing union rows.
  Checkbox items without a counterpart land in `equipment.unmapped`; the
  dealer's full option list (Shadow Line, Driving Assistant Professional, …)
  stays in `equipment.optional`/`.standard`. `Mietwagen` is kept as a feature
  although mobile.de has no such box, since a rental past is history.
- **Sensatec is `Kunstleder`**, as on mobile.de, even though BMW's own
  `seatCoverMaterial` calls it Leather; an Alcantara/Sensatec combination is
  `Alcantara`.
- **A reservation shows as the `availability` fact** (`Reserviert bis …`) and
  as `car.reservedUntil`.
- Ids are `pb-<dealer id>` and the car carries `source`, so `pnpm refresh` and
  `pnpm available` skip it; `pnpm dealer -- --refresh` re-imports those.
  Photos are sized by `&w=` instead of `?rule=`, which `photo()` in `rows.js`
  translates. There is no `priceRating`, dealer rating or opening hours.

## The viewer

Vite + React in `viewer/`, started with `pnpm viewer`.

- **It reads the folder, not a bundle.** A dev-server middleware in
  `viewer/vite.config.js` serves `data/listings/*.json` from disk on every
  `/api/cars` request, so a scrape run shows up on a plain reload. Nothing is
  imported at build time and no data is copied into the app.
- **One flat table.** `viewer/src/rows.js` turns the listings into a single row
  list: price, the union of all `facts` keys, dealer, then the union of all
  features as ✓/–. Union, not intersection — a figure one car is missing shows
  as a gap instead of dropping the row.
- **Car picker in a drawer.** A native `<dialog>` (Escape, backdrop and focus
  trapping come free) holding the full list with photo, title and price. It
  used to be a chip grid above the table, which cost four rows of height once
  the comparison passed a handful of cars.
  Each entry shows where the car stands (city, Luftlinie, dealer) and an ↗
  that opens the listing. A search field on top matches ref, id, title,
  dealer, street and postcode (every term must match; `#7` means exactly #7,
  never #72), and Enter opens the top hit's listing, so `#74 ⏎` is the fast
  way to a car.
- **Rows move.** Drag a row by its label, or use ⤒ / ↑ / ↓; ✕ hides it. Order is
  stored as a full key list, and moves target the next *visible* row, so hidden
  rows never swallow a click.
- **Lists can be filters instead of snapshots.** A list saved with a fixed
  `ids` array (like Favoriten) never changes on its own, so a "unter 30k" list
  went stale the moment a newer, cheaper car was scraped — nobody remembered to
  hit "Aktualisieren". `viewer/src/filters.js` adds a second shape, `{name,
  rules}`: AND-combined rules evaluated against every known car on every
  render, in the Listen drawer. Rule types are deliberately narrow —
  Preis/Kilometerstand (unter/über), Erstzulassung (vor/nach a `MM/YYYY`),
  Kraftstoff/Fahrzeugzustand (each categorized from its free-text fact value —
  "Hybrid (Benzin/Elektro)" would otherwise also match a plain "enthält
  Benzin" text search), Abstandstempomat/Anhängerkupplung/M Sport (vorhanden/
  nicht vorhanden), and a generic free-text search over title/fuel/features as
  a fallback. A filter's name is always free text — the Abstandstempomat/
  Anhängerkupplung fields match mobile.de's own wording directly rather than
  through a translation table, so nobody has to maintain a mapping from "ACC"
  to the string mobile.de actually uses. M Sport and Fahrzeugzustand are the
  exceptions: `filters.js` exports `hasMSport()` and `conditionCategory()`
  (both checked against all 56 listings — see the filter trap below for
  M Sport), which `wishlist.js`'s table-cell colouring also imports, so the
  filter and the 🟢/🟡/🔴 marks (Unfallfrei/Gebrauchtfahrzeug/repariert) or the
  M-Sport badge can never disagree about which cars match.
  The builder itself is hidden until "+ Neue Liste" opens it blank, or
  clicking an existing filter's row opens it pre-filled with that filter's
  rules — the same click that applies it. There is no separate edit button:
  seeing a filter's rules and changing them is one action, and "Filter
  speichern" renames in place rather than leaving the old name behind as a
  second entry (`editingName` in `App.jsx` tracks which saved filter, if any,
  the open builder belongs to).
- **Settings persist** per key under the `car-compare/` prefix: row order,
  hidden rows, favourites, named lists, notes and per-car status in
  localStorage via `useLocalStorage` from `usehooks-ts`; selected cars, sorting
  and table/map per tab via `useTabStorage` (see the sync section).
- **The ⚙ menu** in the header holds everything that is not a view control:
  Neu laden, CSV-Export, JSON-Export, JSON-Import. It is a native `<details>`,
  for the same reason the drawers are `<dialog>`s — only closing on an outside
  click and on Escape is wired up by hand.
- **A render crash shows a page, not a blank one.** `viewer/src/ErrorBoundary.jsx`
  wraps the whole app. It exists because a settings export carrying filter
  lists (`{name, rules}`), imported into a build that only knew `{name, ids}`,
  threw on `list.ids.length` during the first render — and React unmounted the
  tree, including the render that would have drawn the way out. The fallback
  prints the error and offers "Sichern und zurücksetzen", which downloads the
  settings before clearing the `car-compare/` prefix, since notes and lists
  exist nowhere else. The same lesson applies to reading a stored setting at
  all: a list with neither `rules` nor `ids` reads as empty rather than
  throwing, so a format from a future build is at worst inert. An old viewer
  is a real target — Vercel serves the last pushed commit, so an export from
  the dev server routinely lands somewhere behind it.
- **Plain CSS**, one file, palette in custom properties, light and dark via
  `prefers-color-scheme`. No framework, no component library.
- **Installable, and usable offline.** `manifest.webmanifest` (table) and
  `checkliste.webmanifest` (the standalone test-drive checklist in
  `viewer/public/checkliste.html`) make both home-screen apps with their own
  icon. `viewer/public/sw.js` is network-first with the cache as fallback, so
  online nothing is ever stale and at a dealer without reception the last
  loaded state still opens. It pre-caches the checklist, skips cross-origin
  requests (the hotlinked photos) and is not registered on `localhost`, where
  it would fight hot reload. The table works offline from its second visit,
  because the first one loads before the worker controls the page.
- **A new deploy announces itself.** The build bakes its commit into the
  bundle (`__APP_VERSION__`, from `VERCEL_GIT_COMMIT_SHA` or `git rev-parse`
  in `vite.config.js`), and `api/health.js` returns the commit Vercel is
  serving now. `viewer/src/UpdateNotice.jsx` compares the two on load, on tab
  focus and every five minutes, and shows "Neue Version verfügbar" with a
  reload button once they differ. Without it an open tab or the installed app
  keeps an old build for days, since the service worker only swaps code on a
  reload. Off on the dev server and whenever either version is unknown;
  `sw.js` never caches `/api/health`.
- **Photos are hotlinked.** mobile.de's CDN sizes them by query rule
  (`?rule=mo-240`, `mo-360`, `mo-1024`, `mo-1600`), which is why `images[]` is
  stored without a size. Nothing is downloaded.
- **Hiding a car is a localStorage list, not a delete.** For a car you've
  decided against for good (too old, accident, sold) but don't want to
  permanently drop from `data/` yet, the 🗑 button — in the car picker and on
  each car's photo card above the table — adds its id to `car-compare/removed`,
  one click to undo (↺), never touching `data/listings/*.json`. A hidden car
  drops out of *every* list: the default "nothing chosen yet" view, the "Alle"
  entry in the Listen drawer (`visibleIds`), Favoriten, and every saved
  filter's matches (`visibleCars` in `App.jsx`, not the raw car set) — a
  filter's own rules never get a say in whether a hidden car reappears. The
  only two ways to see one again are the dedicated "Ausgeblendet" entry in the
  Listen drawer, and a manually ticked checkbox in the picker. A sold car
  (`car.availability.status === 'sold'`, set by `pnpm available`) is folded
  into the same list automatically on every load — it only ever adds ids, so
  manually restoring one is not undone by the next reload unless that reload
  is what re-discovers it as sold. `pnpm remove-car -- <id | '#ref'>`
  (`scripts/remove-car.mjs`) is the actual, permanent version of this, for
  when you are sure: it deletes the listing file and the index entry, keeping
  the reference number reserved rather than reused.

## Exporting and importing the setup

localStorage is per browser and per origin, so a second instance — another
machine, another browser, the deployed build instead of the dev server — starts
empty with no way to carry over three dozen judgements. `viewer/src/settings.js`
therefore writes the whole setup out as one JSON file and reads it back.

```json
{
  "format": "car-compare-settings",
  "version": 1,
  "exportedAt": "2026-08-28T12:00:00.000Z",
  "settings": { "favourites": ["452520909"], "hidden": ["feature:Sitzheizung"] }
}
```

Four decisions worth keeping:

- **Settings are collected by prefix, not from a list of names.** More than one
  session works on this viewer, so a hand-kept list would go stale the first
  time somebody adds a `useLocalStorage` and forgets to register it — and a
  setting missing from an export is invisible until the import lands somewhere
  else. The prefix scan cannot go stale.
- **Values are stored parsed, not as the raw localStorage strings.** The file
  reads and hand-edits as ordinary JSON instead of as JSON escaped inside JSON.
  `useLocalStorage` always writes `JSON.stringify`, so anything that fails to
  parse was not written by the viewer and is skipped.
- **Import replaces, it does not merge.** An import is meant to reproduce the
  setup it came from; merging would leave the target browser's own hidden rows
  and favourites in place and the result would be neither setup. Because that
  overwrites hand-typed notes and lists, it asks first.
- **No page reload after an import.** `useLocalStorage` re-reads on its own
  `local-storage` event, and an event with no `key` makes *every* hook re-read —
  so `importSettings` dispatches one and the table updates in place. A reload
  would work too, but would wipe the confirmation message off the screen.

The CSV export is a different thing and stays separate: it is the comparison as
it stands on screen (`toCsv` in `rows.js`), not the setup that produced it.

## Syncing the setup across devices

Export/import is a manual carry. The **Sync** entry in the ⚙ menu makes it
automatic for the judgements about cars: **favourites, lists, notes,
status and the Preisanpassung** (`SYNCED` in `viewer/src/sync.js`) live on the server as well, and
every browser holding the sync key keeps in step with them.

- **What is open stays with the tab.** Which cars are selected (and so which
  list is shown), table or map, sorting and the Nur-Unterschiede toggles go
  through `viewer/src/useTabStorage.js`: sessionStorage per tab, mirrored to
  localStorage so a new tab starts from the last view. `useLocalStorage` would
  have pulled every open tab along through the cross-tab `storage` event.
  Hidden rows, row order and hidden cars are per browser and do not sync
  either. Keys an earlier build synced are ignored on read and
  drop off the server with the next write.

- **Off until a key is entered.** Without one the viewer behaves exactly as
  before. The key and the last agreed state live under `car-compare-sync/`,
  outside the settings prefix, so they never ride along in an export.
- **Server:** `api/settings.js` (Vercel function) and the dev-server middleware
  in `viewer/vite.config.js` both call `api/_settings-store.js`. It stores one
  document plus a revision counter in Upstash Redis over its REST API (plain
  `fetch`, no dependency) and writes compare-and-set, so a write based on a
  stale revision gets a 409 instead of overwriting another device.
- **Environment:** `SYNC_TOKEN` (the key you type into the dialog) plus
  `KV_REST_API_URL`/`KV_REST_API_TOKEN` from Vercel's Upstash integration
  (`UPSTASH_REDIS_REST_URL`/`_TOKEN` work too). For the dev server put them in
  the repo's `.env` or `.env.local` (both git-ignored); localhost then uses the
  same store as the deployed site. **Testing against a scratch store:** shell
  variables win over the files, so `KV_REST_API_URL=http://localhost:… pnpm
  viewer` points the dev server elsewhere. Without that, a local test writes
  into the real notes.
- **The first connect decides, and you decide it.** An empty server simply
  receives this browser's state. Otherwise the dialog lists every difference,
  one line per car for notes and status, and each line gets its own choice
  between this browser and the server. That is how the laptop's notes win
  while another device's favourites survive.
- **After that it merges on its own** (`viewer/src/sync.js`): pushes 1.5 s after
  a local write, pulls on load, on tab focus, when coming back online and once
  a minute. A three-way merge against the last agreed state takes whatever only
  one side changed; notes and status merge per car. Only the same setting (or
  the same car's note) changed on both sides at once goes to the device that
  is syncing, which is the one you are typing on.
- **Offline keeps working.** localStorage stays the working copy, and
  `public/sw.js` leaves `/api/settings` alone so a cached answer can never pose
  as the server state. Edits made at a dealer go up with the next round.


## Reference numbers

Every car carries a short internal number (`car.ref`) so a human can say "#7"
instead of quoting `462145366`. The viewer prefixes it to every car label.

The registry lives in `data/refs.json`:

```json
{ "nextRef": 25, "refs": { "462145366": 1, "459175992": 2 } }
```

Three properties make the number safe to quote, and all three are deliberate:

- **Assigned once, on first sight** — `pnpm scrape` numbers each car as it is
  fetched, `pnpm renormalize` backfills anything already on disk.
- **Never changed.** Adding or removing cars must not shift existing numbers, so
  the registry is the authority and is kept in its own file: regenerating
  `data/cars.json` cannot lose it.
- **Never reused.** A sold car keeps its number forever, so **gaps in the
  sequence are normal** — they are sold cars, not bugs.

`pnpm check` fails loudly on a missing number, a collision, or drift between a
car file and the registry, because a silently renumbered car is worse than an
unnumbered one. Do not "tidy up" the gaps: renumbering invalidates every note
and screenshot that referred to the old numbers.

## Assessment: effective price and verdict

Two cars with different factory equipment cannot be compared on their asking
price, because one of them still needs parts fitted. `car.assessment` therefore
carries an **effective price** — asking price plus whatever is missing — and a
one-line verdict, and the viewer shows both as rows (`Effektivpreis`,
`Nachrüstung`, `Bewertung`). `Effektivpreis` is also a sort option.

This is hand-written editorial data, not derived from the listing, so it lives in
`data/assessment.json` for the same reason `data/refs.json` does: `pnpm scrape`
rebuilds each car from the RSC payload and would otherwise drop it.

```json
{
  "retrofitPrices": { "ahk": { "label": "AHK abnehmbar…", "cost": 1600 } },
  "cars": {
    "452520909": {
      "verdict": "top",
      "retrofit": ["camera", "ahk"],
      "note": "Einziges Portimao Blau mit M Sport und ACC — Kamera fehlt."
    }
  }
}
```

- **Retrofit costs are referenced by key, never written per car.** Changing
  `retrofitPrices.ahk.cost` re-prices every car needing that part on the next
  `pnpm renormalize`. Writing the number per car would guarantee drift.
- **Only genuinely retrofittable parts belong in `retrofit`.** ACC, M Sport and
  the seat material cannot be added to a G21 economically, so a car missing one
  of those gets the reason in `note` rather than a cost — an effective price that
  implied otherwise would be a lie.
- **An unassessed car has no `assessment` key at all**, so it reads as a gap in
  the viewer instead of as a car whose effective price equals its asking price.
- `verdict` is one of `top`, `kandidat`, `raus`, and is deliberately not rendered
  as a row — it exists so a script can filter.
- **`factOverrides` corrects a fact the listing states wrongly.** mobile.de's
  fields offer a fixed set of options, so a seller with a Stoff/Sensatec
  combination seat has to tick plain `Stoff` — verified on the listing photos for
  #25 and #29, while #28 really is pure cloth. An override sets `facts[tag]
  .value`, keeps the seller's wording in `.listedValue` and flags `.corrected`,
  and the viewer renders both (`Stoff/Sensatec… (laut Inserat: Stoff, Schwarz)`)
  so the table never passes a judgement off as scraped data. Only override what
  you actually verified, and say where in the `note`.

`renormalize` feeds `listedValue` back into the normalizer rather than the
corrected value, so re-running it cannot turn a correction into the new baseline.
Both are covered by running `pnpm renormalize` twice: the second run must report
`0 changed`.

## Seller location and distance

The listing payload carries the seller's name, address, phone, rating **and
coordinates**, so `car.dealer` is populated for every car and no geocoding
service is needed. Verified across a real 24-car set: name, city, coordinates
and rating complete on all 24; one listing omitted a phone number.

Note the field is `car.dealer`, not `car.contact` — `contact` is mobile.de's own
name for it in the raw payload and does not survive normalization.

`car.derived.distanceFromHomeKm` is the straight-line distance from home to the
seller. Home defaults to Fürth and is overridable:

```bash
HOME_LOCATION="48.1351,11.5820" HOME_LABEL="München" pnpm renormalize
```

It is deliberately great-circle distance: no API key, no network call, and for
triaging two dozen cars across Germany it produces the same ranking a routing
service would. **Do not label it a driving distance** — real routes run 20-30%
longer. The viewer therefore calls the row "Entfernung (Luftlinie)".

`pnpm check` treats a missing location as a blocker rather than a nicety, since
you have to physically drive to the car, and reports how many are within 100 and
200 km.

## Facelift (G20/G21 LCI)

`derived.facelift` is `lci` / `pre-lci` / `unknown` / `other-generation`, with
`derived.faceliftBasis` naming the evidence used. The facelift went into
production around mid-2022, so a 2022 registration year alone cannot settle it.

What the listing data supports, in descending order of reliability:

1. The dealer writes "LCI" or "Facelift" in the title — only 4 of 38 did.
2. `modelRange` sometimes carries BMW's own N suffix (`G21N`, `F31N`). Correct
   when present, but only 1 of 38 dealers filled it in that way.
3. First registration from 2023 on is LCI; up to 06/2022 is pre-facelift. The
   months in between are genuinely undecidable and are reported as `unknown`
   rather than guessed.
4. A **missing** "Volldigitales Kombiinstrument" implies pre-facelift, since the
   LCI has the curved display as standard. **One direction only**: a 03/2021 car
   in this set has the digital cluster, so its presence proves nothing.

Two dead ends, both checked against real data:

- **The KBA type number does not work.** TSN encodes the variant (CYW = 318i,
  DDH = 318d, CVS = 320i, CVU = 330i) and the same code appears on both
  generations — `CYW` sits on a 03/2021 car and on cars whose titles say LCI.
- **`modelRange` is dealer-entered and often wrong.** `G81` is the M3 Touring
  code, yet it appears on plain 318d listings here. Treat `derived.generation`
  as indicative only; it is trustworthy for spotting a different generation
  (F3x) and not much else.

## Effective price

`car.assessment.effectivePrice` is the asking price plus what the missing
must-haves cost to retrofit, so two cars can be compared on what they actually
cost rather than on the sticker.

The retrofit list is **derived from the listing** (`deriveRetrofit` in
`scripts/assessment.mjs`) and applied by both `pnpm scrape` and
`pnpm renormalize`, so a newly scraped car has an effective price immediately:

- no `Anhängerkupplung*` feature (fixed, detachable or swivelling) -> `ahk`
- no `Kamera` in the `parkAssists` fact -> `camera`

Two deliberate exclusions:

- **ACC is never a retrofit cost.** The requirements note that retrofitting it
  on a G21 is barely economical, so a missing ACC is a permanent gap, shown by
  the viewer under "Nicht nachrüstbar" (`permanentGaps`), not a price to add.
- **A car with `verdict: "raus"` is priced as-is.** Costing up a retrofit for a
  car that is out anyway only adds noise.

Prices live once in `retrofitPrices`, so changing `ahk` re-prices every car that
needs one. An entry may still pin the list with an explicit `retrofit` array
when a judgement should beat the derivation.

`verdict` and `note` stay editorial and hand-written. A car without an entry
therefore has an effective price but a null verdict, and still reads as
un-judged in the viewer.

### Mileage/age adjustment

A newer, low-mileage car and an older, high-mileage one aren't comparable on
asking price alone. "New-car bonus" vs. "old-car malus" is a false choice
though — both are the same adjustment once there's a reference point, so
`deriveMileageAdjustment` (`scripts/assessment.mjs`) anchors on the mileage a
car would have at its age under the standard German market assumption of
**15.000 km/Jahr**, and prices the deviation from that at **0,10 €/km**:

```
expectedKm  = ageInYears * referenceKmPerYear
deviationKm = actualKm - expectedKm
adjustment  = deviationKm * ratePerKm      // rounded to the nearest 10 €
```

Fewer km than expected lowers the effective price, more raises it — symmetric
around zero rather than an arbitrary direction. Both constants live in
`assessment.mileageAdjustment` in `data/assessment.json`, next to
`retrofitPrices`, for the same reason: change the rate once, every car
re-prices on the next `pnpm renormalize`.

**A car with `verdict: "raus"` skips the adjustment**, same as its retrofit
list — it also keeps a very old, very low-mileage reject (a decade-old car
with garage-queen mileage) from producing an outsized bonus the linear
km/year model was never meant to price; that model breaks down at the
extremes, where warranty and tech age matter more than kilometers.

### Facelift negative points, boni and the pricing settings

The viewer re-derives the mileage adjustment client-side and adds a second,
optional one: flat negative points ("Negativpunkte" in the settings dialog —
"Malus" reads as a speaking error in German, not a real word there) for a car
the facelift research (`car.derived.facelift`) actually places `pre-lci` —
never for `unknown` (genuinely undecidable registration months) or
`other-generation`, where a penalty would be a guess rather than a judgement.
It adds to the effective price the same direction the mileage deviation does,
not a discount off it: a pre-LCI car is worth less at the same asking price,
so it takes more money to reach an equivalent LCI car.

**Boni** are the other direction: a car worth more at the same asking price
gets a flat amount *subtracted* from its effective price. Three are
configurable, each off by default: **330er** (`is330`: `model` starting with
330, title as fallback — 330i and 330e), **M Sport** (`hasMSport()` from
`filters.js`, so it agrees with the filter and the gap column) and **Hybrid**
(`isHybrid`: the fuel fact, or an `e` after the model number in the title,
because #61 is a 330e listed as plain `Benzin`). A 330e collects both the 330
and the Hybrid bonus. The 330 amount starts at a guessed 2.000 €; M Sport and
Hybrid start at 0 on purpose, since nobody has decided yet what they are worth.
Like the other adjustments, a `raus` car gets none.

The mileage reference/rate, the AHK switch, the facelift negative points and
the boni are editable from the **Preisanpassung** dialog (⚙ menu) and
persisted in `localStorage` under `car-compare/pricing` —
`viewer/src/pricing.js` (`applyPricingSettings`) overrides the
`car.assessment` the server baked into `data/cars.json` with what these
settings compute, without touching `data/assessment.json`. They **sync**
across devices with favourites and notes (`pricing` in `SYNCED`), merged per
knob, so every device shows the same Effektivpreis. A stored object is always
read on top of `DEFAULT_PRICING` (`withPricingDefaults`), so settings saved
before a knob existed pick up its default instead of `undefined`. Because `settings.js` collects everything by the
`car-compare/` prefix, `pricing` rides along in the existing JSON export/import
with no extra code.

The breakdown (each retrofit item, the mileage deviation, the facelift
negative points, each bonus) is not its own row — three components would mean three
mostly-empty rows. It lives in a hover tooltip on the Effektivpreis cell
instead (the ⓘ icon, `effectivePriceBreakdown` in `viewer/src/wishlist.js`),
and that row carries the same price meter bar as the plain `Preis` row above
it.

## Shortlisting

`CAR-REQUIREMENTS.md` is binding and holds the weighting — **read all of it**.
Recommendations built on only its first section have been rejected more than
once. In particular: the 30k price logic, M Sport as a mere wish, and
**distance is explicitly not a buying argument**.

Filter traps, each already got wrong:

- Upholstery is `facts.interior`, not `facts.upholstery`. The latter does not
  exist, so a filter on it silently passes everything.
- Pure cloth (`Stoff, Schwarz`) is out; `Stoff/Sensatec` and
  `Stoff/Alcantara Kombination` are accepted. mobile.de forces combination
  seats to be ticked as plain `Stoff` — the photo check has rescued four cars
  this way (`factOverrides`).
- Do not filter on `derived.facelift === "lci"`. A G21 is required, not a
  facelift; exclude only `other-generation`.
- Check the exterior colour. White is a hard exclusion and easy to miss while
  comparing equipment lists.
- `features` sometimes omits `Sportpaket` even though `Sportfahrwerk` and
  `Sportsitze` are both present (#461917102) — mobile.de's checkbox limitation
  again, not a car that lacks M Sport. Both `viewer/src/wishlist.js`'s
  permanent-gap check and the Listen drawer's M-Sport filter go through
  `hasMSport()` in `filters.js`, which treats that combination as M Sport too;
  a literal text filter on "Sportpaket" still misses it. The title is not used
  as a signal — it is inconsistent both ways ("Sport Line" vs. a genuine M
  Sport, "M Sport" absent from a title whose features do carry `Sportpaket`).

Shadow Line appears only in the dealer's free-text title, never in
`features[]` — take optical claims from the photos, not the feature list.

The saved mobile.de search caps at 30.000 € asking price, so cars that only win
on effective price are missing from it. Anything already in `data/` stays
comparable.

## Data quality

```bash
pnpm check          # duplicates + normalization report over data/
pnpm renormalize    # re-apply normalization to already-scraped JSON, in place
```

`renormalize` exists because the raw values survive in `data/listings/*.json`, so
improving `normalizeFacts()` never requires re-fetching 24 cars from mobile.de.

### What normalization has to handle

Measured against a real 44-car Parkplatz:

- **`attributes[].value` is sometimes an array.** `envkv.co2Costs` carries a
  low/mid/high variant and `envkv.consumptionDetails.fuel` carries five. Passing
  the array through unchanged makes consumers concatenate it into one unreadable
  string. Facts therefore keep both a joined `value` and, when there is more than
  one, an explicit `values` array to render as separate lines.
- **Non-breaking spaces everywhere.** They break display and naive equality
  checks between two cars, so they are folded to normal spaces.
- **Placeholders masquerading as data.** A seller had typed `-- g/km` for CO2.
  In a comparison a placeholder is worse than a blank, so dash/`k.A.`/`n/a`
  values are dropped. Negative real numbers are deliberately still kept.
- **`derived`** holds parsed numbers (`mileageKm`, `powerKw`, `powerHp`,
  `firstRegistration` as `YYYY-MM`, ...) for sorting and diffing, so the viewer
  never parses German number formatting itself.
- **`facts[tag].group`** is `envkv` for consumption/cost disclosures and
  `vehicle` otherwise. Only a handful of listings carry `envkv.*`, so grouping
  lets the viewer treat them as one hideable block rather than many sparse rows.

### Duplicates

`pnpm check` ranks by what the evidence actually proves:

1. same dealer + same `sku` (Fahrzeugnummer) — a re-listing
2. identical make, model, mileage, first registration, power, colour and fuel
3. shared photos **plus** matching mileage/registration

Shared photos alone prove nothing: one dealer group reused the same banner image
across nine listings, and two further pairs shared interior shots while being
plainly different cars. That is stock photography, and `check` reports it as such
instead of crying duplicate.

## Known limits

- Sold/withdrawn listings return "Dieses Fahrzeug ist nicht verfügbar" and are
  reported as failures rather than written.
- ENVKV consumption/CO₂ figures are frequently absent on used-car listings —
  that is missing at the source, not a parser gap.
- Public detail pages need no login. Only `--saved` does, because the Parkplatz
  is account state; pasting a compare URL remains a login-free alternative.
- Selectors here depend on mobile.de's internal payload shape. Expect the
  `"listing":{...}` extraction to need maintenance after a frontend rewrite.

## Conventions

- Node ESM (`"type": "module"`). The scraper stays dependency-free and needs no
  build step; the viewer is the only part with dependencies.
- Fetching and comparing stay decoupled: the viewer reads JSON only and never
  talks to mobile.de.
- Be polite: fetch sequentially, no parallel hammering.

### Git

- **Commit straight to `main`.** This is a small personal project with no review
  flow, so feature branches only fragment the work — the more so because a second
  session may be committing to `main` at the same time. No need to ask, and no
  need to branch first.
- **Pushing is a deploy, so it is not yours to do.** `origin` is
  `github.com/m91michel/mobile-car-overview` and Vercel deploys `main`
  (`vercel.json`: `pnpm viewer:build` → `viewer/dist`), which makes every push a
  publish. Commit freely, then leave the push alone unless asked for it.
- **A push can be rejected, because `main` is shared.** Another session may have
  pushed in the meantime. Rebase onto the remote and push again
  (`git pull --rebase origin main`) rather than forcing — and never
  `--force-with-lease` over a commit you did not write.
- **A `data/` commit is a deploy too.** The build freezes `data/listings/*.json`
  into `dist/api/cars.json` (`generateBundle` in `viewer/vite.config.js`), so the
  deployed site shows the cars as of the last pushed commit. A scrape run that is
  committed but not pushed is invisible online.
- **Do not commit another session's in-flight changes.** More than one Claude
  session works in this repo, so `git status` regularly shows files you did not
  touch. Leave those out of your commit rather than attributing someone else's
  half-finished work, and check whether they have already committed your shared
  files before editing them again.
- Keep regenerated `data/` artifacts in their own commit, so a logic change stays
  readable instead of being buried under two dozen JSON files.
