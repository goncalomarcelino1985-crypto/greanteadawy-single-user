const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id, e.g. uid('ch') -> "ch_k3j9x0a2b1" */
export function uid(prefix = '') {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return prefix ? `${prefix}_${s}` : s;
}
