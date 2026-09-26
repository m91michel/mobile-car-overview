// Health check that also names the deployed commit. The viewer compares it with
// the commit it was built from (viewer/src/UpdateNotice.jsx) and offers a
// reload once they differ, so an open tab or the installed app does not keep
// running an old build for days.
//
// VERCEL_GIT_COMMIT_SHA is one of Vercel's system variables, present at build
// time (where vite.config.js bakes it into the bundle) and at run time here.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, version: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
}
