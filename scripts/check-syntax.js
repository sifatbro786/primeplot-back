// Syntax-check every .js file (node --check). Usage: npm run check
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'uploads', 'coverage']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

let failed = 0;
const files = walk(ROOT);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✖ ${relative(ROOT, f)}\n${r.stderr}`);
  }
}
console.log(failed ? `\n${failed} file(s) failed` : `✔ ${files.length} files OK`);
process.exit(failed ? 1 : 0);
