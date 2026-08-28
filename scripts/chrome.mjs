// Starts (or reports) a real Chrome with remote debugging enabled.
// Uses a dedicated profile dir so your everyday Chrome profile is never touched
// and so a mobile.de login can persist here across runs.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const PORT = Number(process.env.CHROME_PORT ?? 9333);
const PROFILE = resolve(process.env.CHROME_PROFILE ?? '.chrome-profile');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export async function isRunning(port = PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureChrome(port = PORT) {
  if (await isRunning(port)) return { started: false, port };

  const { existsSync } = await import('node:fs');
  const bin = CHROME_PATHS.find((p) => existsSync(p));
  if (!bin) throw new Error(`No Chrome found. Looked in:\n  ${CHROME_PATHS.join('\n  ')}`);

  mkdirSync(PROFILE, { recursive: true });

  // Headless is detected by Akamai, so this window is intentionally visible.
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i++) {
    if (await isRunning(port)) return { started: true, port };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not expose a debugging port on ${port} in time.`);
}

export async function stopChrome(port = PORT) {
  if (!(await isRunning(port))) return false;
  const { execSync } = await import('node:child_process');
  execSync(`pkill -f "remote-debugging-port=${port}"`, { stdio: 'ignore' });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.includes('--stop')) {
    const stopped = await stopChrome();
    console.log(stopped ? 'Chrome stopped.' : 'No debugged Chrome was running.');
  } else {
    const { started, port } = await ensureChrome();
    console.log(
      started
        ? `Started Chrome (profile ${PROFILE}) with CDP on port ${port}.`
        : `Chrome already listening on port ${port}.`,
    );

    const openIndex = args.indexOf('--open');
    if (openIndex !== -1 && args[openIndex + 1]) {
      const { openPage } = await import('./cdp.mjs');
      const page = await openPage(port);
      await page.goto(args[openIndex + 1]);
      await page.close();
      console.log(`Opened ${args[openIndex + 1]} in that window.`);
      console.log('Log in there if needed; the profile keeps the session for later runs.');
    }
  }
}
