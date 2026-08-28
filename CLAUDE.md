See [AGENTS.md](AGENTS.md) for the project goal, architecture, and constraints.

Two rules worth repeating here:

- The fetcher talks to a normal Chrome over raw CDP on purpose. Do not swap it
  for Playwright or Puppeteer — mobile.de's Akamai bot protection detects their
  automation flags and serves a block page instead.
- Never name a script `fetch`. `pnpm fetch` is a pnpm built-in and silently runs
  that instead of the script. The scraper command is `pnpm scrape`.
