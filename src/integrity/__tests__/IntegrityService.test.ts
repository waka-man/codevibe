import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

jest.mock('vscode', () => ({
  window: {
    showWarningMessage: jest.fn(async () => undefined),
    showInformationMessage: jest.fn(async () => undefined),
    showErrorMessage: jest.fn(async () => undefined),
    withProgress: jest.fn(async (_opts: unknown, task: (p: { report: () => void }) => Promise<void>) => {
      await task({ report: () => {} });
    }),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
  ProgressLocation: { Notification: 15 },
}), { virtual: true });

import { IntegrityService } from '../IntegrityService';

function writeFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function hashForDir(outDir: string, excludeIntegrity = true): string {
  const excludedDirs = new Set(['__tests__', 'node_modules']);
  const excludedExt = new Set(['.map']);
  const excludedFiles = new Set(excludeIntegrity ? ['.integrity', '.DS_Store'] : ['.DS_Store']);
  const excludedSuffixes = ['.test.js'];
  const files: { rel: string; full: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(outDir, full);
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (excludedFiles.has(entry.name)) continue;
        if (excludedExt.has(path.extname(entry.name))) continue;
        if (excludedSuffixes.some((s) => entry.name.endsWith(s))) continue;
        files.push({ rel, full });
      }
    }
  };
  walk(outDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f.rel + '\n');
    hash.update(fs.readFileSync(f.full));
    hash.update('\n');
  }
  return hash.digest('hex');
}

describe('IntegrityService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function makeService(outDir = tmpDir): IntegrityService {
    const svc = new IntegrityService();
    (svc as any).outDir = outDir;
    (svc as any).integrityFile = path.join(outDir, '.integrity');
    return svc;
  }

  it('returns missing-embedded when no integrity file exists', () => {
    writeFile(path.join(tmpDir, 'a.js'), 'console.log(1);');
    const svc = makeService();
    const result = svc.verifyLocal();
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('missing-embedded');
    expect(result.expected).toBeNull();
    expect(typeof result.actual).toBe('string');
  });

  it('computes local hash excluding tests/maps/node_modules/.integrity and matches', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, 'sub', 'util.js'), 'util');
    writeFile(path.join(tmpDir, '__tests__', 'x.test.js'), 'ignored');
    writeFile(path.join(tmpDir, 'foo.test.js'), 'ignored');
    writeFile(path.join(tmpDir, 'main.js.map'), 'ignored');
    writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'i.js'), 'ignored');
    writeFile(path.join(tmpDir, '.DS_Store'), 'ignored');
    const svc = makeService();
    const expected = hashForDir(tmpDir);
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash: expected, algorithm: 'sha256' }));
    expect(svc.computeLocalHash()).toBe(expected);
    const embedded = svc.getEmbedded();
    expect(embedded?.hash).toBe(expected);
    const result = svc.verifyLocal();
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('match');
  });

  it('detects mismatch and returns ok=false', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash: 'b'.repeat(64), algorithm: 'sha256' }));
    const svc = makeService();
    const result = svc.verifyLocal();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mismatch');
    expect(result.expected).toBe('b'.repeat(64));
  });

  it('handles unreadable/malformed embedded manifest', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), 'not-json');
    const svc = makeService();
    expect(svc.getEmbedded()).toBeNull();
  });

  it('returns null embedded when hash/version missing', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ algorithm: 'sha256' }));
    const svc = makeService();
    expect(svc.getEmbedded()).toBeNull();
  });

  it('verifyRelease returns null when no integrity hash in body, and verifies when present', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    const svc = makeService();
    const hash = hashForDir(tmpDir);
    expect(svc.verifyRelease({ body: 'no hash here', version: '1.0.0' } as never)).toBeNull();
    const ok = svc.verifyRelease({ body: `notes\nIntegrity: ${hash}`, version: '1.0.0' } as never);
    expect(ok?.ok).toBe(true);
    expect(ok?.reason).toBe('match');
    const bad = svc.verifyRelease({ body: `Integrity: ${'c'.repeat(64)}`, version: '1.0.0' } as never);
    expect(bad?.ok).toBe(false);
    expect(bad?.reason).toBe('mismatch');
  });

  it('safeCompute returns empty string when outDir unreadable', () => {
    const svc = makeService(path.join(tmpDir, 'missing-out'));
    expect((svc as any).safeCompute()).toBe('');
  });

  it('verifyLocal returns unreadable on compute failure', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash: 'a'.repeat(64), algorithm: 'sha256' }));
    const svc = makeService();
    jest.spyOn(svc, 'computeLocalHash').mockImplementation(() => { throw new Error('boom'); });
    const result = svc.verifyLocal();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('verifyRelease returns unreadable on compute failure', () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    const svc = makeService();
    jest.spyOn(svc, 'computeLocalHash').mockImplementation(() => { throw new Error('boom'); });
    const result = svc.verifyRelease({ body: `Integrity: ${'a'.repeat(64)}`, version: '1.0.0' } as never);
    expect(result?.ok).toBe(false);
    expect(result?.reason).toBe('unreadable');
  });

  it('checkAndRepair returns ok result when verified', async () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    const hash = hashForDir(tmpDir);
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash, algorithm: 'sha256' }));
    const svc = makeService();
    const result = await svc.checkAndRepair();
    expect(result.ok).toBe(true);
  });

  it('checkAndRepair locks dashboard and attempts reinstall on mismatch', async () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash: 'd'.repeat(64), algorithm: 'sha256' }));
    const lock = jest.fn();
    const unlock = jest.fn();
    const updateService = {
      getLatestRelease: jest.fn(async () => ({ version: '1.0.0', body: '' })),
      install: jest.fn(async () => undefined),
    } as any;
    const svc = new IntegrityService(updateService, { lock, unlock });
    (svc as any).outDir = tmpDir;
    (svc as any).integrityFile = path.join(tmpDir, '.integrity');
    const vscode = require('vscode');
    (vscode.window.showInformationMessage as unknown as jest.Mock).mockResolvedValueOnce('Reload Window' as never);
    const result = await svc.checkAndRepair();
    expect(result.ok).toBe(false);
    expect(lock).toHaveBeenCalled();
    expect(updateService.install).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('checkAndRepair shows error when release fetch fails or no release', async () => {
    writeFile(path.join(tmpDir, 'main.js'), 'ok');
    writeFile(path.join(tmpDir, '.integrity'), JSON.stringify({ version: '1.0.0', hash: 'e'.repeat(64), algorithm: 'sha256' }));
    const updateService = { getLatestRelease: jest.fn(async () => null), install: jest.fn() } as any;
    const svc = new IntegrityService(updateService);
    (svc as any).outDir = tmpDir;
    (svc as any).integrityFile = path.join(tmpDir, '.integrity');
    const vscode = require('vscode');
    await svc.checkAndRepair();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('setDashboardCallbacks updates callbacks', () => {
    const svc = makeService();
    const lock = jest.fn();
    svc.setDashboardCallbacks({ lock });
    expect((svc as any).lockDashboard).toBe(lock);
  });
});
