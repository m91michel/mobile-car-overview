// Write JSON so that an interrupted write cannot leave a truncated file.
//
// The scraper saves its progress after every car now, so Ctrl-C lands
// mid-write far more often than it used to. A plain writeFileSync that is
// killed halfway leaves invalid JSON, and for data/refs.json that is the one
// file whose loss renumbers every car in the comparison.
//
// rename(2) is atomic within a filesystem, so a reader sees either the old
// file or the new one, never a half-written one.

import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  // Same directory as the target: rename across filesystems is not atomic.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or it never got created.
    }
    throw error;
  }
}
