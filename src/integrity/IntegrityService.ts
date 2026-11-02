/**
 * IntegrityService
 *
 * Verifies that the installed extension matches the published release, so a
 * tampered VSIX (extracted, modified, repackaged) is detected.
 *
 * Two checks, both opt-in friendly and never blocking activation:
 *   1. Local self-check: recompute the hash of out/ and compare with the
 *      embedded .integrity file. Catches naive tampering and corruption.
 *   2. Remote check: compare the local hash with the hash published in the
 *      GitHub release. Catches a tampered embedded hash.
 *
 * No data leaves the machine beyond the existing update-check request.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { UpdateService, UpdateRelease } from '../updates/UpdateService';

export interface IntegrityResult {
  ok: boolean;
  expected: string | null;
  actual: string;
  reason: 'match' | 'mismatch' | 'missing-embedded' | 'unreadable';
}

export class IntegrityService {
  private readonly outDir: string;
  private readonly integrityFile: string;
  private lockDashboard: ((message: string) => void) | null = null;
  private unlockDashboard: (() => void) | null = null;

  constructor(
    private readonly updateService?: UpdateService,
    callbacks?: { lock?: (message: string) => void; unlock?: () => void },
  ) {
    // Compiled to out/integrity/, so out/ is the parent directory.
    this.outDir = path.resolve(__dirname, '..');
    this.integrityFile = path.join(this.outDir, '.integrity');
    this.lockDashboard = callbacks?.lock ?? null;
    this.unlockDashboard = callbacks?.unlock ?? null;
  }

  setDashboardCallbacks(callbacks: { lock?: (message: string) => void; unlock?: () => void }): void {
    this.lockDashboard = callbacks.lock ?? this.lockDashboard;
    this.unlockDashboard = callbacks.unlock ?? this.unlockDashboard;
  }

  /**
   * Read the embedded integrity manifest. Returns null if absent (e.g. running
   * from source without a build).
   */
  getEmbedded(): { version: string; hash: string; algorithm: string } | null {
    try {
      if (!fs.existsSync(this.integrityFile)) return null;
      const raw = fs.readFileSync(this.integrityFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.hash !== 'string' || typeof parsed.version !== 'string') return null;
      return { version: parsed.version, hash: parsed.hash, algorithm: parsed.algorithm || 'sha256' };
    } catch {
      return null;
    }
  }

  /**
   * Recompute the hash of the installed out/ directory, using the same
   * algorithm and file selection as scripts/compute-integrity.js.
   */
  computeLocalHash(): string {
    const excludedDirs = new Set(['__tests__', 'node_modules']);
    const excludedExt = new Set(['.map']);
    const excludedFiles = new Set(['.integrity']);

    const files: { rel: string; full: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.outDir, full);
        if (entry.isDirectory()) {
          if (excludedDirs.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile()) {
          if (excludedFiles.has(entry.name)) continue;
          if (excludedExt.has(path.extname(entry.name))) continue;
          files.push({ rel, full });
        }
      }
    };
    walk(this.outDir);
    files.sort((a, b) => a.rel.localeCompare(b.rel));

    const hash = crypto.createHash('sha256');
    for (const f of files) {
      hash.update(f.rel + '\n');
      hash.update(fs.readFileSync(f.full));
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  /**
   * Local self-check. Returns ok=true when the recomputed hash matches the
   * embedded manifest, or when no manifest is present (dev/source run).
   */
  verifyLocal(): IntegrityResult {
    const embedded = this.getEmbedded();
    if (!embedded) {
      return { ok: true, expected: null, actual: this.safeCompute(), reason: 'missing-embedded' };
    }
    let actual: string;
    try {
      actual = this.computeLocalHash();
    } catch {
      return { ok: false, expected: embedded.hash, actual: '', reason: 'unreadable' };
    }
    if (actual === embedded.hash) {
      return { ok: true, expected: embedded.hash, actual, reason: 'match' };
    }
    return { ok: false, expected: embedded.hash, actual, reason: 'mismatch' };
  }

  /**
   * Verify against a published release. The release is expected to carry the
   * hash in its body as `Integrity: <hex>` (facilitator adds this at release
   * time). Returns null when the release carries no hash.
   */
  verifyRelease(release: UpdateRelease): IntegrityResult | null {
    const match = release.body.match(/Integrity:\s*([0-9a-f]{64})/i);
    if (!match) return null;
    const expected = match[1].toLowerCase();
    let actual: string;
    try {
      actual = this.computeLocalHash();
    } catch {
      return { ok: false, expected, actual: '', reason: 'unreadable' };
    }
    if (actual === expected) {
      return { ok: true, expected, actual, reason: 'match' };
    }
    return { ok: false, expected, actual, reason: 'mismatch' };
  }

  /**
   * Run the local self-check. On failure, lock the dashboard, download and
   * install the authentic version from GitHub (even if the version number is
   * unchanged), and prompt for a reload. Never throws, never offers a
   * "dismiss" escape hatch: a tampered build is not allowed to keep running.
   */
  async checkAndRepair(): Promise<IntegrityResult> {
    const result = this.verifyLocal();
    if (result.ok || result.reason === 'missing-embedded') {
      return result;
    }

    // Lock the dashboard immediately so the user cannot keep using the
    // tampered build while we fetch the authentic one.
    this.lockDashboard?.('CodeVibe is not authentic. Reinstalling the verified version...');

    try {
      vscode.window.showWarningMessage(
        'CodeVibe integrity check failed: the installed extension does not match its published hash. ' +
          'It may have been modified. Reinstalling the authentic version now.',
      );

      const release = this.updateService ? await this.updateService.getLatestRelease() : null;
      if (release) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Reinstalling CodeVibe' },
          async (progress) => {
            progress.report({ message: `Downloading ${release.version}...` });
            await this.updateService!.install(release);
          },
        );
        const reload = await vscode.window.showInformationMessage(
          `Authentic CodeVibe ${release.version} installed. Reload VS Code to finish.`,
          'Reload Window',
        );
        if (reload === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        vscode.window.showErrorMessage(
          'Could not fetch the authentic CodeVibe release. The extension remains locked until a verified build is installed.',
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Reinstall failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }

  private safeCompute(): string {
    try {
      return this.computeLocalHash();
    } catch {
      return '';
    }
  }
}
