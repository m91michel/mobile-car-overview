// Reads the listing ids out of "Mein Parkplatz" (your bookmarked cars).
//
// The Parkplatz is tied to the browser: anonymously it is per-browser, and once
// you are logged in mobile.de syncs it across devices. So the dedicated Chrome
// profile only needs to be signed in once (`pnpm park`), after which every run
// sees the same saved cars.

const PARK_URL = 'https://www.mobile.de/park?layout=list';

// Harvest ids from every place the page might expose them, then dedupe. Being
// generous here means a markup change on one of these does not break the run.
// Harvest ids from the DOM. An earlier version also scanned the RSC payload for
// `"id":<digits>`, but measured against a real 44-car Parkplatz that source
// contributed nothing while being the one most likely to pick up ids from
// recommendations and ads. The DOM attributes and link params independently
// agreed on the exact same set, so redundancy lives there instead.
const HARVEST = `(() => {
  const parked = new Set();
  const comparable = new Set();
  const add = (set, value) => {
    if (value && /^\\d{6,}$/.test(value)) set.add(value);
  };

  // 1. Whatever the parked-vehicle cards tag themselves with.
  for (const node of document.querySelectorAll('[data-listing-id], [data-ad-id]')) {
    add(parked, node.getAttribute('data-listing-id') || node.getAttribute('data-ad-id'));
  }

  // 2. Links: detail slugs, ?id= params, and the "Fahrzeugvergleich" button,
  //    which only carries the cars mobile.de still considers comparable --
  //    a useful signal for which of the parked cars are still on sale.
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') || '';
    const slug = href.match(/(\\d{6,})\\.html/);
    if (slug) add(parked, slug[1]);
    const isCompare = href.includes('/park/compare');
    for (const param of href.matchAll(/[?&]id=(\\d{6,})/g)) {
      add(parked, param[1]);
      if (isCompare) add(comparable, param[1]);
    }
  }

  const text = document.body.innerText || '';
  return {
    ids: [...parked],
    comparable: [...comparable],
    loggedIn: !/\\bAnmelden\\b/.test(text),
    empty: text.includes('Noch kein geparktes Fahrzeug'),
  };
})()`;

export async function readParkplatz(page) {
  await page.goto(PARK_URL);
  const status = await page.waitForStatus(
    `(() => {
      const text = document.body ? document.body.innerText : '';
      if (document.title.includes('Zugriff verweigert')) return 'blocked';
      if (text.includes('Noch kein geparktes Fahrzeug')) return 'empty';
      if (document.querySelector('a[href*=".html"]')) return 'ready';
      return 'pending';
    })()`,
    { timeoutMs: 25000 },
  );

  if (status === 'blocked') {
    throw new Error('mobile.de served its bot-block page for the Parkplatz');
  }

  const result = await page.evaluate(HARVEST);

  if (result.empty || result.ids.length === 0) {
    const hint = result.loggedIn
      ? 'The Parkplatz is signed in but empty.'
      : [
          'That Chrome profile is not signed in to mobile.de, so it sees an empty Parkplatz.',
          'Run `pnpm park`, log in once in the Chrome window that opens, then retry.',
        ].join('\n  ');
    throw new Error(`No parked vehicles found.\n  ${hint}`);
  }

  return { ids: result.ids, comparable: result.comparable ?? [] };
}

export { PARK_URL };
