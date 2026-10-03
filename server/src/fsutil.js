// Small filesystem helpers shared by the stores.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

/** Write a file atomically: a crash mid-write never leaves a truncated file behind. */
export async function writeFileAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, mode ? { mode } : undefined);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Constant-time string comparison (for secrets). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
