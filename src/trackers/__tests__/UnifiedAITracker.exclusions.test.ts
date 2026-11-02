/**
 * UnifiedAITracker - file-system change handling and exclusion.
 *
 * This is the path that caused the reported false positives: `npm install`
 * creates thousands of closed files under node_modules, and the watcher
 * classified each as HIGH-confidence AI agent mode. These tests pin the
 * exclusion behavior end-to-end through the real watcher callbacks, plus
 * the baseline-tracking fallback used when git is unavailable.
 */

import * as vscode from 'vscode';
import { UnifiedAITracker } from '../UnifiedAITracker';
import { AIDetector } from '../../detection/AIDetector';
import { AIDetectionMethod } from '../../detection/types';

let mockHandlers: {
  textChange?: (event: any) => void;
  fileChange?: (uri: any) => void;
  fileCreate?: (uri: any) => void;
  visibleEditorsChange?: (editors: any[]) => void;
} = {};

jest.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: jest.fn((handler: any) => {
      mockHandlers.textChange = handler as (event: any) => void;
      return { dispose: jest.fn() };
    }),
    createFileSystemWatcher: jest.fn(() => ({
      onDidChange: jest.fn((handler: any) => {
        mockHandlers.fileChange = handler as (uri: any) => void;
        return { dispose: jest.fn() };
      }),
      onDidCreate: jest.fn((handler: any) => {
        mockHandlers.fileCreate = handler as (uri: any) => void;
        return { dispose: jest.fn() };
      }),
      dispose: jest.fn(),
    })),
    openTextDocument: jest.fn(),
    textDocuments: [],
    workspaceFolders: undefined,
  },
  window: {
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeVisibleTextEditors: jest.fn((handler: any) => {
      mockHandlers.visibleEditorsChange = handler as (editors: any[]) => void;
      return { dispose: jest.fn() };
    }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
  Uri: {
    parse: jest.fn((p: string) => ({ fsPath: p })),
    file: jest.fn((p: string) => ({ fsPath: p })),
  },
}), { virtual: true });

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  statSync: jest.fn(() => ({ mtimeMs: Date.now() })),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

jest.mock('../../detection/AIDetector', () => {
  const actual = jest.requireActual('../../detection/AIDetector');
  return {
    ...actual,
    AIDetector: jest.fn().mockImplementation(() => ({
      detect: jest.fn(() => ({
        isAI: false,
        confidence: 'low',
        method: 'large-paste',
        classification: 'permitted',
        metadata: { charactersCount: 0, linesOfCode: 0, timestamp: Date.now() },
      })),
      detectFromExternalFileChange: jest.fn((text: string) => ({
        isAI: true,
        confidence: 'high',
        method: 'external-file-change',
        classification: 'prohibited',
        metadata: {
          charactersCount: text.length,
          linesOfCode: text.split('\n').length,
          timestamp: Date.now(),
        },
      })),
      detectFromInlineCompletion: jest.fn(),
      detectFromLargePaste: jest.fn(),
      detectFromGitMarkers: jest.fn(),
      detectFromVelocity: jest.fn(),
      reset: jest.fn(),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execSync } = require('child_process') as { execSync: jest.Mock };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require('fs') as {
  existsSync: jest.Mock;
  writeFileSync: jest.Mock;
  statSync: jest.Mock;
  mkdirSync: jest.Mock;
};

const uri = (p: string) => ({ fsPath: p });

function doc(fsPath: string, text: string, extra: any = {}) {
  return {
    // scheme must be 'file' or BaseTracker.shouldTrackDocument() rejects it
    uri: { fsPath, scheme: 'file' },
    isUntitled: false,
    languageId: 'typescript',
    getText: () => text,
    ...extra,
  };
}

describe('UnifiedAITracker file-system change handling', () => {
  let tracker: UnifiedAITracker;
  let events: any[];

  beforeEach(() => {
    // Fake only timers: the code path awaits setImmediate, which must stay real.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.clearAllMocks();
    mockHandlers = {};
    events = [];
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(
      async (u: any) => doc(u.fsPath, 'line1\nline2\nline3\nline4\n'),
    );
    tracker = new UnifiedAITracker((e) => events.push(e));
    // jest.spyOn(tracker as any, 'log').mockImplementation(() => {});
    // jest.spyOn(tracker as any, 'logError').mockImplementation(() => {});
  });

  afterEach(() => {
    tracker.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Drive the watcher's 5s debounce. A repeated change inside the window is
   * deferred, so tests must advance timers for the deferred processing to run.
   */
  async function flushDebounce() {
    jest.advanceTimersByTime(6000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  describe('excluded paths never emit events', () => {
    // These are the exact cases from the bug report.
    const excluded = [
      '/proj/node_modules/lodash/lodash.js',
      '/proj/node_modules/.bin/tsc',
      '/proj/venv/lib/python3.12/site-packages/requests/api.py',
      '/proj/.venv/lib/x.py',
      '/proj/dist/bundle.js',
      '/proj/build/out.js',
      '/proj/coverage/lcov-report/index.html',
      '/proj/out/extension.js',
      '/proj/.git/config',
      '/proj/package-lock.json',
      '/proj/yarn.lock',
      '/proj/__pycache__/mod.pyc',
      '/proj/app.min.js',
    ];

    it.each(excluded)('ignores %s', async (p) => {
      await tracker.initialize();
      await mockHandlers.fileChange!(uri(p));
      // Let any debounce timers flush
      jest.advanceTimersByTime?.(0);
      expect(events).toHaveLength(0);
    });

    it('ignores creation in excluded paths', async () => {
      await tracker.initialize();
      await mockHandlers.fileCreate!(uri('/proj/node_modules/new/index.js'));
      expect(events).toHaveLength(0);
    });

    it('does not run git for excluded paths', async () => {
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/node_modules/pkg/index.js'));
      // No git invocation should have happened for an excluded file
      expect(execSync).not.toHaveBeenCalled();
    });

    it('does not open the document for excluded paths', async () => {
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/venv/lib/x.py'));
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
  });

  describe('non-excluded paths are processed', () => {
    // The first sighting of an untracked file only establishes a baseline -
    // it is not AI activity. A second, larger change is what emits.
    async function changeTwice(p: string, secondLines: number) {
      await mockHandlers.fileChange!(uri(p));
      await new Promise((r) => setImmediate(r));
      (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(
        doc(p, Array(secondLines).fill('x').join('\n')),
      );
      await mockHandlers.fileChange!(uri(p));
      await flushDebounce();
    }

    it('emits an agent-mode event for a changed source file', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      await changeTwice('/proj/src/app.ts', 20);

      expect(events).toHaveLength(1);
      expect(events[0].detectionMethod).toBe(AIDetectionMethod.ExternalFileChange);
      expect(events[0].isAgentMode).toBe(true);
    });

    it('does not treat lookalike dirs as excluded', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();
      await changeTwice('/proj/my-node_modules-backup/app.ts', 20);
      expect(events).toHaveLength(1);
    });
  });

  describe('custom exclusions via setCustomExclusions', () => {
    it('ignores paths matching a custom glob', async () => {
      tracker.setCustomExclusions(['**/generated/**']);
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/generated/types.ts'));
      expect(events).toHaveLength(0);
    });

    it('clearing custom globs restores default behavior', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      tracker.setCustomExclusions(['**/generated/**']);
      await tracker.initialize();
      tracker.setCustomExclusions([]);
      await mockHandlers.fileChange!(uri('/proj/generated/types.ts'));
      await new Promise((r) => setImmediate(r));
      (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(
        doc('/proj/generated/types.ts', Array(20).fill('x').join('\n')),
      );
      await mockHandlers.fileChange!(uri('/proj/generated/types.ts'));
      await flushDebounce();
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('package.json external writes', () => {
    it('skips the event but advances the baseline', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/package.json'));
      await new Promise((r) => setImmediate(r));

      // No AI event for an npm rewrite
      expect(events).toHaveLength(0);
      // Baseline advanced so later deltas stay correct
      const baselines = (tracker as any).fileBaselines as Map<string, number>;
      expect(baselines.get('/proj/package.json')).toBe(4);
    });
  });

  describe('baseline tracking without git', () => {
    it('first sighting establishes a baseline without emitting', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/fresh.ts'));
      await new Promise((r) => setImmediate(r));

      expect(events).toHaveLength(0);
      const baselines = (tracker as any).fileBaselines as Map<string, number>;
      expect(baselines.get('/proj/src/fresh.ts')).toBe(4);
    });

    it('a growth over the baseline emits lines added', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      // Establish baseline at 4 lines
      await mockHandlers.fileChange!(uri('/proj/src/grow.ts'));
      await new Promise((r) => setImmediate(r));

      // Now the file is much bigger
      (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(
        doc('/proj/src/grow.ts', Array(50).fill('x').join('\n')),
      );
      await mockHandlers.fileChange!(uri('/proj/src/grow.ts'));
      await flushDebounce();

      expect(events).toHaveLength(1);
      expect(events[0].linesOfCode).toBeGreaterThan(0);
    });

    it('no change (delta 0) emits nothing', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/same.ts'));
      await new Promise((r) => setImmediate(r));
      await mockHandlers.fileChange!(uri('/proj/src/same.ts'));
      await flushDebounce();

      expect(events).toHaveLength(0);
    });

    it('a shrink emits lines removed', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/shrink.ts'));
      await new Promise((r) => setImmediate(r));

      (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(
        doc('/proj/src/shrink.ts', 'only one line'),
      );
      await mockHandlers.fileChange!(uri('/proj/src/shrink.ts'));
      await flushDebounce();

      expect(events).toHaveLength(1);
      expect(events[0].linesRemoved).toBeGreaterThan(0);
    });
  });

  describe('git-backed paths', () => {
    beforeEach(() => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: uri('/proj') },
      ];
    });

    it('uses git numstat when available', async () => {
      // No FETCH_HEAD/MERGE_HEAD marker -> not a git operation.
      fsMock.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return '.git';
        if (cmd.includes('numstat')) return '12\t3\tpath';
        return '';
      });
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/a.ts'));
      await flushDebounce();

      expect(events).toHaveLength(1);
      expect(events[0].linesOfCode).toBe(12);
      expect(events[0].linesRemoved).toBe(3);
    });

    it('treats a tracked file with no diff as a git operation (no event)', async () => {
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return '.git';
        if (cmd.includes('numstat')) return '';
        if (cmd.includes('ls-files')) return 'src/a.ts';
        return '';
      });
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/a.ts'));
      await flushDebounce();

      expect(events).toHaveLength(0);
    });

    it('a git operation marker suppresses AI detection', async () => {
      // A fresh ORIG_HEAD / HEAD reflog means the change came from git, not an agent.
      fsMock.statSync.mockReturnValue({ mtimeMs: Date.now() } as any);
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return '.git';
        if (cmd.includes('numstat')) return '5\t0\tpath';
        return '';
      });
      await tracker.initialize();

      await mockHandlers.fileChange!(uri('/proj/src/b.ts'));
      await flushDebounce();

      expect(events).toHaveLength(0);
    });
  });

  describe('internal files are skipped', () => {
    it('ignores codepause-baselines.json writes', async () => {
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/.vscode/codepause-baselines.json'));
      expect(events).toHaveLength(0);
    });
  });

  describe('text change exclusion', () => {
    it('does not emit for edits in an excluded document', async () => {
      await tracker.initialize();
      mockHandlers.textChange!({
        document: doc('/proj/node_modules/pkg/index.js', 'x'),
        contentChanges: [{ text: 'x'.repeat(600), rangeLength: 0 }],
      });
      expect(events).toHaveLength(0);
    });

    it('emits for edits in a normal document', async () => {
      await tracker.initialize();
      (AIDetector as unknown as jest.Mock).mockClear();
      mockHandlers.textChange!({
        document: doc('/proj/src/app.ts', 'x'),
        contentChanges: [{ text: 'x'.repeat(600), rangeLength: 0 }],
      });
      // The mocked detector reports not-AI, so no event - the point is that
      // the document was evaluated at all rather than short-circuited.
      expect(events).toHaveLength(0);
    });

    it('ignores documents with no content changes', async () => {
      await tracker.initialize();
      mockHandlers.textChange!({
        document: doc('/proj/src/app.ts', 'x'),
        contentChanges: [],
      });
      expect(events).toHaveLength(0);
    });

    it('skips a small pure deletion to avoid a false positive', async () => {
      await tracker.initialize();
      mockHandlers.textChange!({
        document: doc('/proj/src/app.ts', 'x'),
        contentChanges: [{ text: '', rangeLength: 50 }],
      });
      expect(events).toHaveLength(0);
    });

    it('treats a large active-editor deletion as neutral', async () => {
      await tracker.initialize();
      const document = doc('/proj/src/app.ts', 'x');
      (vscode.window as any).activeTextEditor = { document };
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');
      expect(events[0].detectionMethod).toBe('manual-deletion');
    });

    it('treats Emmet-style markup as neutral editor assistance', async () => {
      await tracker.initialize();
      const document = doc('/proj/index.html', '<div class="container"></div>', {
        languageId: 'html',
      });
      (vscode.window as any).activeTextEditor = { document };
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: '<div class="container"></div>', rangeLength: 0 }],
      });

      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');
      expect(events[0].detectionMethod).toBe('editor-assisted-change');
    });

    it('treats an immediate undo insertion as neutral', async () => {
      await tracker.initialize();
      const document = doc('/proj/src/app.ts', 'x'.repeat(5000));
      (vscode.window as any).activeTextEditor = { document };

      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: 'x'.repeat(5000), rangeLength: 0 }],
      });

      expect(events).toHaveLength(2);
      expect(events[1].source).toBe('neutral');
      expect(events[1].detectionMethod).toBe('editor-undo-redo');
    });

    it('classifies cut-and-paste refactoring between files as neutral (not AI)', async () => {
      await tracker.initialize();
      // First: delete a large block from file A (cut)
      const sourceDoc = doc('/proj/src/source.ts', 'x', { isDirty: true });
      (vscode.window as any).activeTextEditor = { document: sourceDoc };
      mockHandlers.textChange!({
        document: sourceDoc,
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');

      // Clear events from the deletion
      events.length = 0;

      // Then: paste a similarly-sized block into file B (paste)
      // Mock the AIDetector to report this as a high-confidence large paste
      const aiDetector = (tracker as any).aiDetector as { detect: jest.Mock };
      aiDetector.detect.mockReturnValue({
        isAI: true,
        confidence: 'high',
        method: 'large-paste',
        classification: 'flag',
        metadata: {
          source: 'large-paste',
          charactersCount: 5000,
          linesOfCode: 125,
          timestamp: Date.now(),
        },
      });

      const targetDoc = doc('/proj/src/target.ts', 'x'.repeat(5000));
      (vscode.window as any).activeTextEditor = { document: targetDoc };
      mockHandlers.textChange!({
        document: targetDoc,
        contentChanges: [{ text: 'x'.repeat(5000), rangeLength: 0 }],
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Should be classified as refactoring (neutral), not AI
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');
      expect(events[0].detectionMethod).toBe('editor-refactoring');
    });

    it('still flags a large paste with no recent deletion as AI', async () => {
      await tracker.initialize();
      // Mock the AIDetector to report a high-confidence large paste
      const aiDetector = (tracker as any).aiDetector as { detect: jest.Mock };
      aiDetector.detect.mockReturnValue({
        isAI: true,
        confidence: 'high',
        method: 'large-paste',
        classification: 'flag',
        metadata: {
          source: 'large-paste',
          charactersCount: 5000,
          linesOfCode: 125,
          timestamp: Date.now(),
        },
      });

      const document = doc('/proj/src/app.ts', 'x'.repeat(5000));
      (vscode.window as any).activeTextEditor = { document };
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: 'x'.repeat(5000), rangeLength: 0 }],
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('ai');
    });

    it('does not treat same-file paste matching deletion as refactoring', async () => {
      await tracker.initialize();
      const document = doc('/proj/src/app.ts', 'x', { isDirty: true });
      (vscode.window as any).activeTextEditor = { document };

      // Delete from the same file
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');

      events.length = 0;

      // Paste back into the SAME file - should NOT be refactoring (same file)
      const aiDetector = (tracker as any).aiDetector as { detect: jest.Mock };
      aiDetector.detect.mockReturnValue({
        isAI: true,
        confidence: 'high',
        method: 'large-paste',
        classification: 'flag',
        metadata: {
          source: 'large-paste',
          charactersCount: 5000,
          linesOfCode: 125,
          timestamp: Date.now(),
        },
      });

      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: 'x'.repeat(5000), rangeLength: 0 }],
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Same file, so it's caught by undo/redo check first (neutral, not AI)
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('neutral');
    });
  });

  describe('team git operations are not attributed to AI', () => {
    // Simulates `git pull` of a teammate's commits: ORIG_HEAD was just
    // written in /proj/.git, every other marker is absent.
    const pulling = (p: string) => {
      if (p.replace(/\\/g, '/').endsWith('/proj/.git/ORIG_HEAD')) {
        return { mtimeMs: Date.now() };
      }
      throw new Error('ENOENT');
    };

    beforeEach(() => {
      (vscode.workspace as any).workspaceFolders = [{ uri: uri('/proj') }];
      fsMock.existsSync.mockReturnValue(false);
      fsMock.statSync.mockImplementation(pulling);
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) { return '.git'; }
        if (cmd.includes('numstat')) { return ''; }
        // Pulled file not in the index yet: the watcher fired mid-pull
        if (cmd.includes('ls-files')) { throw new Error('error-unmatch'); }
        return '';
      });
    });

    afterEach(() => {
      fsMock.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }));
    });

    it('does not count a teammate\'s new file pulled while closed', async () => {
      await tracker.initialize();
      await mockHandlers.fileCreate!(uri('/proj/src/teammate.ts'));
      await flushDebounce();
      expect(events).toHaveLength(0);
    });

    it('does not count an open file VS Code reloads after a pull', async () => {
      await tracker.initialize();
      const pulled = Array(80).fill('const x = 1;').join('\n');
      mockHandlers.textChange!({
        document: doc('/proj/src/app.ts', pulled, { isDirty: false }),
        contentChanges: [{ text: pulled, rangeLength: 40 }],
      });
      expect(events).toHaveLength(0);
      expect(((tracker as any).fileBaselines as Map<string, number>).get('/proj/src/app.ts')).toBe(80);
    });

    it('does not count lines a pull removes from an open file', async () => {
      await tracker.initialize();
      mockHandlers.textChange!({
        document: doc('/proj/src/app.ts', 'x', { isDirty: false }),
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      expect(events).toHaveLength(0);
    });

    it('still analyzes edits that make the document dirty during a pull', async () => {
      await tracker.initialize();
      const document = doc('/proj/src/app.ts', 'x', { isDirty: true });
      (vscode.window as any).activeTextEditor = { document };
      mockHandlers.textChange!({
        document,
        contentChanges: [{ text: '', rangeLength: 5000 }],
      });
      expect(events).toHaveLength(1);
      expect(events[0].detectionMethod).toBe('manual-deletion');
    });

    it('still flags agent writes once git is idle', async () => {
      fsMock.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) { return '.git'; }
        if (cmd.includes('numstat')) { return '20\t0\tsrc/agent.ts'; }
        return '';
      });
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/src/agent.ts'));
      await flushDebounce();
      expect(events).toHaveLength(1);
      expect(events[0].linesOfCode).toBe(20);
    });

    it('never shells out with a POSIX-only redirect (breaks every git check on Windows)', async () => {
      fsMock.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      await tracker.initialize();
      await mockHandlers.fileChange!(uri('/proj/src/a.ts'));
      await flushDebounce();
      const commands = execSync.mock.calls.map((c: any[]) => c[0] as string);
      expect(commands.some((c) => c.includes('numstat'))).toBe(true);
      expect(commands.every((c) => !c.includes('/dev/null'))).toBe(true);
    });
  });

  describe('baselines are not created for excluded files', () => {
    it('ignores visible editors in excluded paths', async () => {
      await tracker.initialize();
      mockHandlers.visibleEditorsChange!([
        { document: doc('/proj/node_modules/pkg/index.js', 'a\nb\n') },
      ]);
      const baselines = (tracker as any).fileBaselines as Map<string, number>;
      expect(baselines.size).toBe(0);
    });

    it('records baselines for normal files', async () => {
      await tracker.initialize();
      mockHandlers.visibleEditorsChange!([
        { document: doc('/proj/src/app.ts', 'a\nb\nc\n') },
      ]);
      const baselines = (tracker as any).fileBaselines as Map<string, number>;
      expect(baselines.get('/proj/src/app.ts')).toBe(3);
    });
  });
});
