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
  `usehooks-ts`, all under the `car-compare/` prefix: selected cars, row order,
  hidden rows, both filters, favourites, named lists, notes and per-car status.
- **The ⚙ menu** in the header holds everything that is not a view control:
  Neu laden, CSV-Export, JSON-Export, JSON-Import. It is a native `<details>`,
  for the same reason the drawers are `<dialog>`s — only closing on an outside
  click and on Escape is wired up by hand.
- **Plain CSS**, one file, palette in custom properties, light and dark via
  `prefers-color-scheme`. No framework, no component library.
- **Photos are hotlinked.** mobile.de's CDN sizes them by query rule
  (`?rule=mo-240`, `mo-360`, `mo-1024`, `mo-1600`), which is why `images[]` is
  stored without a size. Nothing is downloaded.

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
