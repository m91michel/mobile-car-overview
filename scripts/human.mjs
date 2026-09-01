// Reach a listing the way a person does: from the Parkplatz, by clicking it.
//
// Why bother, when Page.navigate to the detail URL works?
//
// Akamai Bot Manager scores a session on more than request rate. Its sensor
// script collects interaction telemetry - mouse movement, click coordinates,
// scroll, timing - and a session that produces none of it while pulling four
// dozen deep links is an obvious outlier. The direct-navigation path also
// gives away two smaller things: no Referer at all on every hit, and
// `action=compareItem` in a URL nobody clicked, where the Parkplatz's own
// links say `action=parkItem`.
//
// HONEST LIMITS. This is plausible, not measured:
//
//   - The one lever with a proven mechanism is **volume**. Forty-odd detail
//     pages in a quarter of an hour is not a human evening regardless of how
//     the URLs were reached. Clicking through does not raise the ceiling;
//     `--limit` and more than one sitting do.
//   - Whether the referrer survives depends on the anchor's `rel`. If
//     mobile.de sets `noreferrer`, that part buys nothing.
//   - No A/B test is possible here without spending blocks to get the data,
//     so treat the click path as "not worse, probably better", never as a
//     licence to fetch more.
//
// Everything here degrades to direct navigation rather than failing a car, so
// turning it on cannot make a run fail that would otherwise have worked.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

export const PARK_URL = 'https://www.mobile.de/park?layout=list';

/** Move the pointer along a few eased steps instead of teleporting. */
export async function moveTo(page, x, y, { steps = 6 } = {}) {
  for (let i = 1; i <= steps; i++) {
    // ease-out: quick at first, settling onto the target
    const t = 1 - (1 - i / steps) ** 2;
    await page.mouseMove(Math.round(x * t), Math.round(y * t));
    await sleep(rand(25, 70));
  }
}

/**
 * Spend a plausible moment on the listing, scrolling down it.
 *
 * Not decoration: the payload is already parsed by the time this runs, so the
 * only thing it changes is the shape of the session. A human opening a car
 * they saved looks at the photos and the equipment list; leaving 180ms after
 * the last byte does not.
 */
export async function readListing(page, { minMs = 4000, maxMs = 11000 } = {}) {
  const budget = rand(minMs, maxMs);
  const until = Date.now() + budget;
  while (Date.now() < until) {
    await page.scrollBy(Math.round(rand(180, 520)));
    await sleep(rand(500, 1500));
    // Occasionally glance back up, the way a person re-checks a figure.
    if (Math.random() < 0.15) {
      await page.scrollBy(-Math.round(rand(120, 300)));
      await sleep(rand(300, 900));
    }
  }
  return Math.round(budget);
}

const PARK_READY = `(() => {
  const t = document.title || '';
  if (t.includes('Zugriff verweigert')) return 'blocked';
  if (document.querySelector('[data-listing-id]')) return 'ready';
  if ((document.body ? document.body.innerText : '').includes('Noch kein geparktes Fahrzeug')) return 'empty';
  return 'pending';
})()`;

/** Put the browser on the Parkplatz list, loading it only if it is not there. */
export async function ensureParkplatz(page, { timeoutMs = 25000 } = {}) {
  const onPark = await page
    .evaluate(`location.pathname.startsWith('/park') && !!document.querySelector('[data-listing-id]')`)
    .catch(() => false);
  if (onPark) return 'ready';

  await page.goto(PARK_URL);
  const status = await page.waitForStatus(PARK_READY, { timeoutMs });
  if (status === 'blocked') {
    throw Object.assign(new Error('bot-block page served'), { blocked: true });
  }
  return status;
}

/**
 * Click the parked card for `id`, so the detail page is reached by a real
 * click from a real list page.
 *
 * The cards' links carry target="_blank", which would spawn a tab to chase and
 * close for every car. Stripping the attribute first keeps the click, the
 * referrer and the `action=parkItem` URL while navigating this tab - the one
 * deviation from what a hand would do, and the cheapest by far.
 *
 * @returns {Promise<boolean>} false when the card is not on the page, which is
 *   normal: a sold car drops out of the Parkplatz. The caller falls back.
 */
export async function clickParkedCard(page, id) {
  const spot = await page.evaluate(`(() => {
    const card = document.querySelector('[data-listing-id="${id}"], [data-ad-id="${id}"]');
    if (!card) return null;
    const link = card.querySelector('a[href*="details.html"]');
    if (!link) return null;
    link.removeAttribute('target');
    link.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = link.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

  if (!spot) return false;

  // A beat between the card scrolling into view and the click on it.
  await sleep(rand(400, 1100));
  await moveTo(page, spot.x, spot.y);
  await sleep(rand(120, 380));
  await page.mouseClick(spot.x, spot.y);
  return true;
}

/** Back to the list, as a person would, rather than re-fetching the URL. */
export async function backToParkplatz(page) {
  await page.evaluate('history.back()').catch(() => {});
  await page.waitForStatus(PARK_READY, { timeoutMs: 15000 }).catch(() => 'pending');
  await sleep(rand(600, 1600));
}

/** Every so often a person stops to do something else. */
export async function maybePause({ chance = 0.12, minMs = 20000, maxMs = 70000 } = {}) {
  if (Math.random() >= chance) return 0;
  const wait = Math.round(rand(minMs, maxMs));
  console.log(`        pausing ${Math.round(wait / 1000)}s`);
  await sleep(wait);
  return wait;
}
