// Reads the listing ids out of "Mein Parkplatz" (your bookmarked cars).
//
// The Parkplatz is tied to the browser: anonymously it is per-browser, and once
// you are logged in mobile.de syncs it across devices. So the dedicated Chrome
// profile only needs to be signed in once (`pnpm park`), after which every run
// sees the same saved cars.

const PARK_URL = 'https://www.mobile.de/park?layout=list';

// Harvest ids from every place the page might expose them, then dedupe. Being
// generous here means a markup change on one of these does not break the run.
const HARVEST = `(() => {
  const ids = new Set();
  const add = (value) => {
    if (value && /^\\d{6,}$/.test(value)) ids.add(value);
  };

  // 1. Links to detail pages (/…/<id>.html) and any ?id= parameters, which is
  //    also how the "Fahrzeugvergleich" button encodes the whole selection.
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') || '';
    const slug = href.match(/(\\d{6,})\\.html/);
    if (slug) add(slug[1]);
    for (const param of href.matchAll(/[?&]id=(\\d{6,})/g)) add(param[1]);
  }

  // 2. The React Server Component payload, which carries the parked listings
  //    as data even when the markup keeps them behind lazy sections.
  const flight = (self.__next_f || [])
    .map((chunk) => (Array.isArray(chunk) ? chunk[1] : null))
    .filter((text) => typeof text === 'string')
    .join('');
  for (const match of flight.matchAll(/"id":(\\d{6,})/g)) add(match[1]);

  // 3. Anything the DOM tags with an id attribute we recognise.
  for (const node of document.querySelectorAll('[data-listing-id], [data-ad-id]')) {
    add(node.getAttribute('data-listing-id') || node.getAttribute('data-ad-id'));
  }

  const text = document.body.innerText || '';
  return {
    ids: [...ids],
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

  return result.ids;
}

export { PARK_URL };
