#!/usr/bin/env node
'use strict';

/**
 * Bundle the extension for the VSIX package.
 *
 * - Wipes out/ (including the tsc output)
 * - esbuild-bundles src/extension.ts to out/extension.js
 *   (all runtime dependencies inlined; only vscode and sql.js external)
 * - Re-computes out/.integrity over the final out/ directory
 *
 * The resulting VSIX is small (~1.5 MB of extension code) and needs no
 * node_modules besides sql.js's wasm file (matched by .vscodeignore).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');

// 1. Wipe out/
fs.rmSync(OUT_DIR, { recursive: true, force: true });

// 2. Copy sql.js wasm next to the bundle so the VSIX needs no node_modules
const sqljsDist = path.join(ROOT, 'node_modules', 'sql.js', 'dist');
const outSqlJs = path.join(OUT_DIR, 'sql.js');
fs.mkdirSync(outSqlJs, { recursive: true });
for (const file of ['sql-wasm.js', 'sql-wasm.wasm']) {
  fs.copyFileSync(path.join(sqljsDist, file), path.join(outSqlJs, file));
}

// 3. Bundle
const esbuild = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const args = [
  path.join(ROOT, 'src', 'extension.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--minify',
  '--external:vscode',
  `--outfile=${path.join(OUT_DIR, 'extension.js')}`,
];
console.log(`[bundle] ${esbuild} ${args.join(' ')}`);

// esbuild.cmd on Windows needs shell:true
const isWindows = process.platform === 'win32';
execFileSync(esbuild, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows });

// 3. Re-compute integrity over the final out/
const integrityScript = path.join(ROOT, 'scripts', 'compute-integrity.js');
execFileSync(process.execPath, [integrityScript], { cwd: ROOT, stdio: 'inherit' });

console.log('[bundle] done');
