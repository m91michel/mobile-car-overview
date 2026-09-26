// Vercel endpoint for the settings sync. All logic is in _settings-store.js,
// which the dev server uses as well.

import { handleSettings } from './_settings-store.js';

export default async function handler(req, res) {
  const { status, body } = await handleSettings({
    method: req.method,
    authorization: req.headers.authorization,
    body: req.body,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
