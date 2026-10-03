// Minimal, defensive ZIP reader/writer for plugin packages (no dependency). Reading enforces limits before anything is
// inflated: entry count, per-file and total uncompressed size, compression ratio (zip bombs), CRC-32, and safe relative
// paths (no absolute paths, "..", backslashes, drive letters or links). Only "stored" and "deflate" entries.
import zlib from 'node:zlib';

export const ZIP_LIMITS = { maxEntries: 256, maxFileBytes: 30 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 200 };
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,150}$/;

export class ZipError extends Error {}

/** Is this a safe relative path inside a package? */
export function safeZipPath(name) {
  if (typeof name !== 'string' || !PATH_RE.test(name) || name.includes('//')) return false;
  const parts = name.split('/');
  return parts.length <= 6 && parts.every((x) => x && !x.startsWith('.'));
}

/** Junk that archivers add (macOS resource forks, .DS_Store, hidden files): ignored, not an error. */
const isJunk = (name) => name.startsWith('__MACOSX/') || name.split('/').some((x) => x.startsWith('.') && x !== '.' && x !== '..');

/**
 * Read a zip from a Buffer. Returns Map(path → Buffer) of files (directories skipped).
 * A single top-level folder (zipping "my-plugin/") is stripped so plugin.json sits at the root.
 */
export function readZip(buf, limits = ZIP_LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('Not a zip file');
  // End of central directory: last 22..65557 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
  if (count > limits.maxEntries) throw new ZipError(`Too many files in the zip (max ${limits.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipError('Corrupt zip (central directory)');
  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Corrupt zip (central directory entry)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 0x1) throw new ZipError(`Encrypted entries are not supported (${name})`);
    if (name.endsWith('/') || isJunk(name)) continue; // directories and archiver junk
    if (((extAttr >>> 16) & 0o170000) === 0o120000) throw new ZipError(`Symbolic links are not allowed (${name})`);
    if (!safeZipPath(name)) throw new ZipError(`Unsafe or unsupported file name in the zip: "${name.slice(0, 80)}"`);
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression in ${name} (use "stored" or "deflate")`);
    if (usize > limits.maxFileBytes) throw new ZipError(`${name} is too large (max ${Math.round(limits.maxFileBytes / 1048576)} MB)`);
    if (csize > 0 && usize / csize > limits.maxRatio && usize > 1024 * 1024) throw new ZipError(`${name} is suspiciously compressed (zip bomb?)`);
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError(`The plugin is too large unpacked (max ${Math.round(limits.maxTotalBytes / 1048576)} MB)`);
    entries.push({ name, method, crc, csize, usize, local });
  }
  // strip one common top-level folder ("my-plugin/plugin.json" → "plugin.json")
  const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')));
  const strip = tops.size === 1 && !tops.has('') && entries.every((e) => e.name.includes('/')) ? `${[...tops][0]}/` : '';
  const files = new Map();
  for (const e of entries) {
    const lp = e.local;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) throw new ZipError(`Corrupt zip (local header of ${e.name})`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    if (start + e.csize > buf.length) throw new ZipError(`Corrupt zip (data of ${e.name})`);
    const raw = buf.subarray(start, start + e.csize);
    let data;
    try {
      data = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) });
    } catch {
      throw new ZipError(`Could not decompress ${e.name} (corrupt or larger than declared)`);
    }
    if (data.length !== e.usize) throw new ZipError(`${e.name}: size mismatch`);
    if ((zlib.crc32(data) >>> 0) !== e.crc) throw new ZipError(`${e.name}: CRC mismatch (corrupt zip)`);
    const name = e.name.slice(strip.length);
    if (files.has(name)) throw new ZipError(`Duplicate file in the zip: ${name}`);
    files.set(name, data);
  }
  // a name can't be both a file and a folder ("a.txt" and "a.txt/b.txt")
  const dirs = new Set();
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const name of files.keys()) if (dirs.has(name)) throw new ZipError(`"${name}" is both a file and a folder in the zip`);
  return files;
}

/** Write a zip (deflate) from [{ name, data: Buffer }] — used by the plugin pack script and the tests. */
export function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const useStore = comp.length >= data.length;
    const body = useStore ? data : comp;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useStore ? 0 : 8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useStore ? 0 : 8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
