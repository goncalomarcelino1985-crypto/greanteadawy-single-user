#!/usr/bin/env node
// Pack a GreanTeaDawy plugin folder into an installable .zip, validated by the server's own install check
// (PluginStore.inspect: zip reader, manifest, code checks, audio samples, sizes).
//   npm run plugin:pack -- plugins/examples/tape-wobble        → plugins/dist/greanteadawy.tape-wobble-1.0.0.zip
//   npm run plugin:pack -- --examples                          → every folder in plugins/examples
// Only what the plugin needs goes in: plugin.json, its main .js, its samples, and README.md / LICENSE(.txt|.md) /
// icon.png when present.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../server/src/zip.js';
import { validatePackage } from '../server/src/plugins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL = ['README.md', 'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'icon.png'];

const MAX_UPLOAD = 20 * 1024 * 1024; // the studio's upload limit for plugins

export function packPlugin(dir, outDir = path.join(root, 'plugins', 'dist')) {
  if (!fs.existsSync(path.join(dir, 'plugin.json'))) throw new Error('no plugin.json in the folder');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (e) { throw new Error(`plugin.json: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must be a JSON object');
  // file names as the studio reads them from plugin.json (control characters → spaces, trimmed)
  // eslint-disable-next-line no-control-regex
  const name = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : null);
  const isFile = (f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } };
  const wanted = new Set(['plugin.json']);
  if (name(raw.main)) wanted.add(name(raw.main));
  for (const z of Array.isArray(raw.samples) ? raw.samples : []) if (name(z?.file)) wanted.add(name(z.file));
  for (const f of wanted) if (!isFile(f)) throw new Error(`${f} is listed in plugin.json but isn't in the folder`);
  for (const f of OPTIONAL) if (isFile(f)) wanted.add(f === 'LICENSE' ? 'LICENSE.txt' : f);
  const entries = [...wanted].map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f === 'LICENSE.txt' && !isFile(f) ? 'LICENSE' : f)) }));
  const zip = writeZip(entries);
  const { manifest: m } = validatePackage(zip); // the server's own install check, on the zip itself
  if (zip.length > MAX_UPLOAD) throw new Error(`the zip is ${Math.round(zip.length / 1048576)} MB; the studio accepts up to 20 MB`);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${m.id}-${m.version}.zip`);
  fs.writeFileSync(out, zip);
  return { out, manifest: m, files: entries.length, bytes: zip.length };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pack-plugin.mjs')) {
  const args = process.argv.slice(2);
  const dirs = args[0] === '--examples'
    ? fs.readdirSync(path.join(root, 'plugins', 'examples'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'plugins', 'examples', d.name))
    : args.map((a) => path.resolve(a));
  if (!dirs.length) {
    console.error('Usage: npm run plugin:pack -- <plugin folder> | --examples');
    process.exit(2);
  }
  let failed = false;
  for (const dir of dirs) {
    try {
      const r = packPlugin(dir);
      console.log(`✓ ${r.manifest.name} ${r.manifest.version} (${r.manifest.type}) → ${path.relative(process.cwd(), r.out)} (${r.files} files, ${Math.round(r.bytes / 1024)} KB)`);
    } catch (e) {
      failed = true;
      console.error(`✗ ${path.relative(process.cwd(), dir)}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
