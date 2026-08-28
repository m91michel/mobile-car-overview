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
| `--delay <ms>` | pause between listings per worker (default 1200) |
| `--retries <n>` | retries per listing (default 2, with backoff) |
| `--concurrency <n>` | parallel tabs (default 1) |

Two things make batch runs bearable:

- **Adaptive waiting.** Instead of sleeping a fixed few seconds per page, the
  fetcher polls a cheap in-page probe (`LISTING_READY_PROBE`) until the RSC
  payload is complete, so fast pages cost what they should.
- **Failures stay local.** A sold or slow listing is retried, then recorded and
  skipped; the run continues and the index is merged rather than replaced.
  Sold-out cars alone do not fail the run's exit code.

Keep `--concurrency` low (1-3). It drives real tabs in one browser, which is
ordinary behaviour, but a dozen parallel tabs is not.

### Mein Parkplatz (bookmarked cars)

The Parkplatz is per-browser when anonymous and synced to your account once you
are signed in. So sign the dedicated profile in **once** with `pnpm park`; after
that `pnpm saved` sees the same bookmarks on every run, and the whole comparison
can be refreshed without pasting URLs.

`scripts/parkplatz.mjs` harvests ids from three places at once — detail links,
the compare-button URL, and the RSC payload — and dedupes, so a markup change in
any one of them does not break the run.

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
- **Rows move.** Drag a row by its label, or use ⤒ / ↑ / ↓; ✕ hides it. Order is
  stored as a full key list, and moves target the next *visible* row, so hidden
  rows never swallow a click.
- **Settings persist** per key in localStorage via `useLocalStorage` from
  `usehooks-ts`: selected cars, row order, hidden rows, both filters.
- **Plain CSS**, one file, palette in custom properties, light and dark via
  `prefers-color-scheme`. No framework, no component library.
- **Photos are hotlinked.** mobile.de's CDN sizes them by query rule
  (`?rule=mo-240`, `mo-360`, `mo-1024`, `mo-1600`), which is why `images[]` is
  stored without a size. Nothing is downloaded.

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

- Node ESM (`"type": "module"`), no build step, dependency-free at runtime.
- Fetching and comparing stay decoupled: the viewer reads JSON only and never
  talks to mobile.de.
- Be polite: fetch sequentially, no parallel hammering.
