// Minimal Chrome DevTools Protocol client over the built-in WebSocket (Node >= 22).
// Deliberately dependency-free: Playwright/Puppeteer set automation flags that
// mobile.de's Akamai Bot Manager detects. Attaching to a plain Chrome does not.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attach to a page in the debugged Chrome.
 * @param {number} port
 * @param {{newTab?: boolean}} options newTab opens its own tab, so several
 *   pages can be driven concurrently without fighting over one target.
 */
export async function openPage(port, { newTab = false } = {}) {
  const base = `http://127.0.0.1:${port}`;

  let target;
  let ownsTarget = false;
  if (!newTab) {
    const targets = await listTargets(base);
    target = targets.find((t) => t.type === 'page');
  }
  if (!target) {
    const res = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    target = await res.json();
    ownsTarget = true;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`Could not open CDP socket on ${base}`));
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,

    async close() {
      ws.close();
      // Only tear down tabs we opened ourselves.
      if (ownsTarget) await fetch(`${base}/json/close/${target.id}`).catch(() => {});
    },

    async goto(url, { settleMs = 0 } = {}) {
      await send('Page.navigate', { url });
      if (settleMs) await sleep(settleMs);
    },

    async evaluate(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.result?.exceptionDetails) {
        throw new Error(res.result.exceptionDetails.text ?? 'evaluate failed');
      }
      return res.result?.result?.value;
    },

    /**
     * Poll an in-page expression until it stops returning 'pending'.
     * Cheaper and much faster than a fixed sleep: a listing that is ready in
     * 900ms does not cost the same as one that needs six seconds.
     */
    async waitForStatus(expression, { timeoutMs = 20000, intervalMs = 250 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last = 'pending';
      while (Date.now() < deadline) {
        try {
          last = await this.evaluate(expression);
          if (last && last !== 'pending') return last;
        } catch {
          // Navigation in flight tears down the execution context; retry.
        }
        await sleep(intervalMs);
      }
      return last ?? 'timeout';
    },

    html() {
      return this.evaluate('document.documentElement.outerHTML');
    },

    title() {
      return this.evaluate('document.title');
    },
  };
}

async function listTargets(base) {
  try {
    const res = await fetch(`${base}/json/list`);
    return await res.json();
  } catch {
    throw new Error(`No Chrome with remote debugging on ${base}. Start one with: pnpm chrome`);
  }
}
