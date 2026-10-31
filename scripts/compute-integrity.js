#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const INTEGRITY_FILE = path.join(OUT_DIR, '.integrity');

// Files never shipped in the VSIX, so they must not contribute to the hash.
const EXCLUDED = new Set(['.integrity']);
const EXCLUDED_EXT = new Set(['.map']);
// Directories that are never shipped.
const EXCLUDED_DIRS = new Set(['__tests__', 'node_modules']);

function walk(dir, base) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      result.push(...walk(full, base));
    } else if (entry.isFile()) {
      if (EXCLUDED.has(entry.name)) continue;
      if (EXCLUDED_EXT.has(path.extname(entry.name))) continue;
      result.push({ full, rel });
    }
  }
  return result;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error('[integrity] out/ does not exist; run `npm run compile` first.');
    process.exit(1);
  }

  const files = walk(OUT_DIR, OUT_DIR).sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f.rel + '\n');
    hash.update(fs.readFileSync(f.full));
    hash.update('\n');
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const payload = {
    algorithm: 'sha256',
    version: pkg.version,
    hash: hash.digest('hex'),
    fileCount: files.length,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(INTEGRITY_FILE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[integrity] wrote ${INTEGRITY_FILE}`);
  console.log(`[integrity] version=${payload.version} files=${payload.fileCount} hash=${payload.hash}`);
}

main();
