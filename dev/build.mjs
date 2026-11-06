// Merges src/*.mjs into one huajian/client.mjs (the AI 导演 Plus build, adapted).
//
// Why one file: Folia imports the entry as `client.mjs?v=<fingerprint>`, but a
// sibling imported as `./x.mjs` carries no version, so after a reload the page
// keeps old copies of siblings and mixes old and new code. The vendored PixiJS
// never changes, so its import is kept as the one real import at the top.
//
// Each module gets its own function scope; `import { a } from './x.mjs'`
// becomes `const { a } = __x;`, `export const a` a returned binding. Only the
// forms this codebase uses are supported; anything else fails loudly.
//
// Run: node dev/build.mjs          release: dev-only modules become stubs
//      node dev/build.mjs --dev    with the evaluation tools, for our own runs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const outFile = path.join(root, 'huajian', 'client.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'huajian', 'mod.json'), 'utf8'));

const DEV = process.argv.includes('--dev');
// What a dev-only module becomes in the release (its own imports go with it).
const RELEASE_STUBS = { evaluate: 'export const createEvaluator = null;' };
const DEV_ONLY = new Set(['eval-set']); // reachable only through a stubbed module

const IMPORT = /^import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)\.mjs';\s*$/;
const VENDOR = /^import \* as PIXI from '\.\/vendor\/pixi\.min\.mjs';\s*$/;
const varOf = (name) => `__${name.replace(/-/g, '_')}`;

const parse = (name) => {
  const source = !DEV && RELEASE_STUBS[name] !== undefined
    ? RELEASE_STUBS[name]
    : fs.readFileSync(path.join(srcDir, `${name}.mjs`), 'utf8').replace(/\r\n/g, '\n');
  const deps = [];
  const exports = [];
  let lineNo = 0;
  const lines = [];
  for (const raw of source.split('\n')) {
    lineNo += 1;
    if (raw.startsWith('/// <reference')) continue;
    if (VENDOR.test(raw)) continue;
    const imported = IMPORT.exec(raw);
    if (imported) {
      deps.push(imported[2]);
      lines.push(`const {${imported[1]}} = ${varOf(imported[2])};`);
      continue;
    }
    if (/^import\s/.test(raw)) throw new Error(`${name}.mjs:${lineNo}: unsupported import: ${raw}`);
    const exported = /^export const (\w+)/.exec(raw);
    if (exported) {
      exports.push(exported[1]);
      lines.push(raw.replace(/^export const/, 'const'));
      continue;
    }
    if (/^export\s/.test(raw) && !/^export default async function activate/.test(raw)) {
      throw new Error(`${name}.mjs:${lineNo}: unsupported export: ${raw}`);
    }
    lines.push(raw);
  }
  return { name, deps, exports, body: lines.join('\n').trim() };
};

const order = [];
const seen = new Set();
const visit = (name, trail = []) => {
  if (trail.includes(name)) throw new Error(`import cycle: ${[...trail, name].join(' -> ')}`);
  if (seen.has(name)) return;
  const mod = parse(name);
  for (const dep of mod.deps) visit(dep, [...trail, name]);
  seen.add(name);
  order.push(mod);
};
visit('client');

const unused = fs.readdirSync(srcDir).filter((file) => file.endsWith('.mjs') && !seen.has(file.slice(0, -4)) && (DEV || !DEV_ONLY.has(file.slice(0, -4))));
if (unused.length > 0) console.warn(`not reachable from client.mjs (left out): ${unused.join(', ')}`);

const parts = [
  `// 花笺 ${manifest.version}${DEV ? ' (developer build)' : ''} — built from src/ by dev/build.mjs; edit src/, not this file.`,
  '// Source modules are kept in separate scopes below, in dependency order.',
  "import * as PIXI from './vendor/pixi.min.mjs';",
  '',
];
for (const mod of order) {
  if (mod.name === 'client') {
    parts.push('// ---- src/client.mjs (entry)', mod.body, '');
  } else {
    parts.push(`// ---- src/${mod.name}.mjs`, `const ${varOf(mod.name)} = (() => {`, mod.body, `return { ${mod.exports.join(', ')} };`, '})();', '');
  }
}
fs.writeFileSync(outFile, parts.join('\n'));
console.log(`built ${path.relative(root, outFile)}${DEV ? ' (dev)' : ''}: ${order.length} modules, ${fs.statSync(outFile).size} bytes`);

// --install: copy the mod into this machine's Folia mods folder (reload the mod in Folia afterwards).
if (process.argv.includes('--install')) {
  const appData = process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.config');
  const target = path.join(appData, 'Folia', 'mods', manifest.id);
  fs.cpSync(path.join(root, 'huajian'), target, { recursive: true });
  console.log(`installed to ${target}`);
}
