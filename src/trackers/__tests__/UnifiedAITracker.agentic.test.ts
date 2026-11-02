/**
 * Regression tests for agentic (external file change) detection.
 *
 * These drive the REAL processFileChange path against a REAL git repository.
 *
 * History: git diff was invoked as
 *   git diff HEAD --numstat -- "<path>" 2>/dev/null
 * On Windows execSync runs through cmd.exe, where `2>/dev/null` resolves to a
 * literal C:\dev\nul and fails the entire command. The failure was swallowed
 * by a catch that reported "not a git repo", so every agent-created file fell
 * through to baseline-only handling and emitted no event at all - agentic use
 * detection was silently dead on Windows while pastes still worked.
 *
 * @jest-environment node
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

jest.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    createFileSystemWatcher: jest.fn(() => ({
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
      onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
      dispose: jest.fn(),
    })),
    openTextDocument: jest.fn(async (uri: any) => {
      const p = typeof uri === 'string' ? uri : uri.fsPath;
      const text = fs.readFileSync(p, 'utf8');
      return {
        uri: { fsPath: p, scheme: 'file' },
        languageId: 'typescript',
        getText: () => text,
        lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
      };
    }),
    textDocuments: [],
    getWorkspaceFolder: jest.fn(() => undefined),
    workspaceFolders: undefined as any,
  },
  window: {
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeVisibleTextEditors: jest.fn(() => ({ dispose: jest.fn() })),
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
  commands: { registerCommand: jest.fn(() => ({ dispose: jest.fn() })) },
  Uri: {
    parse: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
    file: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
  },
}), { virtual: true });

import { UnifiedAITracker } from '../UnifiedAITracker';

function makeTracker(onEvent: (e: unknown) => void): UnifiedAITracker {
  // requireActual so AIDetector is the real implementation, not the
  // module-level jest mock used by the other suites.
  const { UnifiedAITracker: Real } = jest.requireActual<any>('../UnifiedAITracker');
  const { AIDetector: RealDetector } = jest.requireActual<any>('../../detection/AIDetector');
  const t = new Real(onEvent);
  (t as any).aiDetector = new RealDetector();
  return t as UnifiedAITracker;
}

function code(lines: number, salt = 'a'): string {
  return (
    Array.from({ length: lines }, (_, n) => `export const ${salt}${n} = ${n};`).join('\n') +
    '\n'
  );
}

describe('agentic file change detection (real git repo)', () => {
  let repo: string;
  let tracker: UnifiedAITracker;
  let events: any[];

  beforeEach(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agentic-')));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t.com', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    execSync('git config commit.gpgsign false', { cwd: repo });

    fs.writeFileSync(path.join(repo, 'seed.ts'), code(5, 'seed'));
    execSync('git add -A', { cwd: repo });
    execSync('git commit -qm seed', { cwd: repo });

    events = [];
    tracker = makeTracker((e: unknown) => events.push(e));
    await tracker.initialize();

    const vscode = require('vscode');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo }, name: 'repo' }];
    vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: repo }, name: 'repo' });
  });

  afterEach(() => {
    tracker?.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function fire(fileName: string): Promise<void> {
    await (tracker as any).processFileChange(
      { fsPath: path.join(repo, fileName), scheme: 'file' },
      path.join(repo, fileName),
    );
  }

  it('flags brand new files created on disk by an agent', async () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), code(30, 'a'));
    fs.writeFileSync(path.join(repo, 'b.ts'), code(30, 'b'));
    fs.writeFileSync(path.join(repo, 'c.ts'), code(30, 'c'));

    await fire('a.ts');
    await fire('b.ts');
    await fire('c.ts');

    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.detectionMethod).toBe('external-file-change');
      expect(e.isAgentMode).toBe(true);
      expect(e.source).toBe('ai');
      expect(e.metadata.isAgentGenerated).toBe(true);
      // tool attribution rides along in metadata; with process scanning off
      // and no local evidence it must stay 'unknown' rather than guessing.
      expect(e.metadata.aiTool).toBe('unknown');
      expect(e.metadata.aiToolEstimated).toBe(true);
    }
    expect(events.map((e) => e.filePath.split(path.sep).pop())).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('flags an existing tracked file that an agent appended to', async () => {
    const target = path.join(repo, 'tracked.ts');
    fs.writeFileSync(target, code(10, 'orig'));
    execSync('git add -A', { cwd: repo });
    execSync('git commit -qm tracked', { cwd: repo });

    fs.appendFileSync(target, code(25, 'agent'));

    await fire('tracked.ts');

    expect(events).toHaveLength(1);
    expect(events[0].detectionMethod).toBe('external-file-change');
    // numstat for an append is the number of added lines only
    expect(events[0].linesOfCode).toBe(25);
  });

  it('does not flag a pull/merge that moved HEAD under the file', async () => {
    const target = path.join(repo, 'tracked.ts');
    fs.writeFileSync(target, code(10, 'base'));
    execSync('git add -A', { cwd: repo });
    execSync('git commit -qm base', { cwd: repo });

    // Simulate "git operation" by rewriting the file to exactly match HEAD.
    fs.writeFileSync(target, code(10, 'base'));

    await fire('tracked.ts');

    expect(events).toHaveLength(0);
  });

  it('does not flag package-manager manifest rewrites', async () => {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n',
    );
    execSync('git add -A', { cwd: repo });
    execSync('git commit -qm pkg', { cwd: repo });

    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '*' } }, null, 2) +
        '\n',
    );

    await fire('package.json');

    expect(events).toHaveLength(0);
  });

  it('still flags files when the workspace is not a git repo', async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cv-bare-')));
    try {
      const vscode = require('vscode');
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: bare }, name: 'bare' }];
      vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: bare }, name: 'bare' });

      const local: any[] = [];
      const t2 = makeTracker((e: unknown) => local.push(e));
      await t2.initialize();

      const first = path.join(bare, 'gen.ts');
      fs.writeFileSync(first, code(20, 'gen'));

      // First sight of a file in a non-git workspace only establishes a baseline.
      await (t2 as any).processFileChange({ fsPath: first, scheme: 'file' }, first);
      expect(local).toHaveLength(0);

      // A later growth of the same file is real agent output.
      fs.appendFileSync(first, code(15, 'more'));
      await (t2 as any).processFileChange({ fsPath: first, scheme: 'file' }, first);
      expect(local).toHaveLength(1);
      expect(local[0].detectionMethod).toBe('external-file-change');

      t2.dispose();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});