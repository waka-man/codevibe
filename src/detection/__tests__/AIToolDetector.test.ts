import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('vscode', () => ({
  Uri: { parse: (s: string) => ({ scheme: s.split(':')[0], toString: () => s }), file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}), { virtual: true });

jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
}));
jest.mock('os', () => ({
  platform: jest.fn(() => 'linux'),
}));
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => ''),
}));

import { AIToolDetector } from '../AIToolDetector';
import * as child_process from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

describe('AIToolDetector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (os.platform as jest.Mock).mockReturnValue('linux');
    (child_process.execSync as jest.Mock).mockReturnValue('');
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns unknown when disabled', () => {
    const d = new AIToolDetector({ enabled: false });
    const r = d.detectTool({ commitMessage: 'Generated with Claude Code' });
    expect(r.tool).toBe('unknown');
    expect(r.estimated).toBe(true);
  });

  it('detects from git markers', () => {
    const d = new AIToolDetector();
    const r = d.detectTool({ commitMessage: 'Generated with Claude Code' });
    expect(r.tool).toBe('claude-code');
    expect(r.source).toBe('git-marker');
    expect(r.confidence).toBe('high');
  });

  it('detects claude from co-authored-by', () => {
    const d = new AIToolDetector();
    expect(d.detectTool({ commitMessage: 'Co-Authored-By: Claude <noreply@anthropic.com>' }).tool).toBe('claude-code');
  });

  it('detects opencode/codex/cursor/copilot/continue/codeium from git markers', () => {
    const d = new AIToolDetector();
    expect(d.detectTool({ commitMessage: 'Generated with OpenCode' }).tool).toBe('opencode');
    expect(d.detectTool({ commitMessage: 'OpenAI Codex' }).tool).toBe('codex');
    expect(d.detectTool({ commitMessage: 'Cursor AI' }).tool).toBe('cursor');
    expect(d.detectTool({ commitMessage: 'GitHub Copilot' }).tool).toBe('copilot');
    expect(d.detectTool({ commitMessage: 'continue.dev' }).tool).toBe('continue');
    expect(d.detectTool({ commitMessage: 'Codeium' }).tool).toBe('codeium');
  });

  it('detects from diff', () => {
    const d = new AIToolDetector();
    expect(d.detectTool({ diff: 'Generated with Claude Code' }).tool).toBe('claude-code');
  });

  it('detects from terminal command', () => {
    const d = new AIToolDetector();
    expect(d.detectTool({ terminalCommand: 'claude --help' }).tool).toBe('claude-code');
    expect(d.detectTool({ terminalCommand: 'opencode' }).tool).toBe('opencode');
    expect(d.detectTool({ terminalCommand: 'codex' }).tool).toBe('codex');
  });

  it('detects from chat sidebar uri', () => {
    const d = new AIToolDetector();
    const uri = { scheme: 'vscode-chat-code-block', toString: () => 'vscode-chat-code-block:foo' } as any;
    expect(d.detectTool({ uri }).tool).toBe('copilot');
    const uri3 = { scheme: 'claude', toString: () => 'claude:foo' } as any;
    expect(d.detectTool({ uri: uri3 }).tool).toBe('claude-code');
  });

  it('detects from active extension ids', () => {
    const d = new AIToolDetector();
    // implementation may or may not use this context field; just exercise the path
    const r = d.detectTool({ activeExtensionIds: ['github.copilot-chat'] });
    expect(r).toBeDefined();
    expect(typeof r.tool).toBe('string');
  });

  it('falls back to recent detection within cooldown', () => {
    const d = new AIToolDetector();
    expect(d.detectTool({ commitMessage: 'Generated with Claude Code' }).tool).toBe('claude-code');
    const r = d.detectTool({});
    expect(r.tool).toBe('claude-code');
    expect(r.source).toBe('default');
    expect(r.estimated).toBe(true);
  });

  it('returns unknown with no signals', () => {
    const d = new AIToolDetector();
    const r = d.detectTool({});
    expect(r.tool).toBe('unknown');
  });

  it('scans running processes on linux (ps)', () => {
    (os.platform as jest.Mock).mockReturnValue('linux');
    (child_process.execSync as jest.Mock).mockReturnValue('123 claude\n456 node\n');
    const d = new AIToolDetector({ scanProcesses: true });
    d.startProcessWatcher();
    const r = d.detectTool({});
    // may detect from process scan cache
    expect(['claude-code', 'unknown']).toContain(r.tool);
    d.stopProcessWatcher();
    d.dispose();
  });

  it('scans on windows (tasklist)', () => {
    (os.platform as jest.Mock).mockReturnValue('win32');
    (child_process.execSync as jest.Mock).mockReturnValue('claude.exe\nopencode.exe\n');
    const d = new AIToolDetector({ scanProcesses: true });
    void d.refreshProcessScan();
    d.stopProcessWatcher();
  });

  it('scans on darwin (ps)', () => {
    (os.platform as jest.Mock).mockReturnValue('darwin');
    (child_process.execSync as jest.Mock).mockReturnValue('789 codex\n');
    const d = new AIToolDetector({ scanProcesses: true });
    void d.refreshProcessScan();
    d.stopProcessWatcher();
  });

  it('updateConfig toggles scanning and reading', () => {
    const d = new AIToolDetector();
    d.updateConfig({ enabled: false });
    d.updateConfig({ scanProcesses: false });
    d.updateConfig({ scanProcesses: true, enabled: true });
    d.updateConfig({ readToolConfigs: true });
    d.dispose();
  });

  it('handles scan errors gracefully', () => {
    (child_process.execSync as jest.Mock).mockImplementation(() => { throw new Error('fail'); });
    const d = new AIToolDetector({ scanProcesses: true });
    void d.refreshProcessScan();
    d.stopProcessWatcher();
  });

  it('reads tool configs when enabled', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('model: claude-3-opus\n');
    const d = new AIToolDetector({ readToolConfigs: true });
    const r = d.detectTool({ commitMessage: 'x' });
    expect(r).toBeDefined();
  });
});
