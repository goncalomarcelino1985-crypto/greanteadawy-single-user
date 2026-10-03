#!/usr/bin/env node
// Zip each music-production skill in skills/ for upload to Claude Desktop / claude.ai (Settings → Capabilities →
// Skills): skills/dist/<name>.zip containing <name>/SKILL.md and its files. Checks each SKILL.md's front matter.
//   npm run skills:pack
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../server/src/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const out = path.join(root, 'dist');

function files(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('.') || d.name === '__pycache__' || d.name === 'dist') return [];
    const rel = base ? `${base}/${d.name}` : d.name;
    return d.isDirectory() ? files(path.join(dir, d.name), rel) : [rel];
  });
}

let failed = false;
fs.mkdirSync(out, { recursive: true });
for (const d of fs.readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === 'dist') continue;
  const dir = path.join(root, d.name);
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) throw new Error('SKILL.md has no front matter');
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
    const description = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim();
    if (name !== d.name) throw new Error(`front matter name "${name}" must equal the folder name`);
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error('name: lowercase letters, digits and dashes, ≤ 64 chars');
    if (!description || description.length > 1024) throw new Error('description is required (≤ 1024 chars)');
    for (const link of md.matchAll(/\]\(([^)#:]+)(#[^)]*)?\)/g)) {
      if (!fs.existsSync(path.join(dir, link[1]))) throw new Error(`broken link to ${link[1]}`);
    }
    const list = files(dir);
    const zip = writeZip(list.map((f) => ({ name: `${name}/${f}`, data: fs.readFileSync(path.join(dir, f)) })));
    fs.writeFileSync(path.join(out, `${name}.zip`), zip);
    console.log(`✓ ${name} → skills/dist/${name}.zip (${list.length} files)`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${d.name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
