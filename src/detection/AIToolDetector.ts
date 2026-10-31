import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AITool } from '../types';

export type AIToolName =
  | 'copilot'
  | 'cursor'
  | 'claude-code'
  | 'opencode'
  | 'codex'
  | 'continue'
  | 'codeium'
  | 'unknown';

export interface AIToolDetection {
  tool: AIToolName;
  model: string | null;
  confidence: 'high' | 'medium' | 'low';
  source: 'cli-process' | 'extension' | 'terminal' | 'git-marker' | 'chat-sidebar' | 'default';
  estimated: boolean;
}

interface KnownAITool {
  name: AIToolName;
  displayName: string;
  cliProcesses: string[];
  extensionIds: string[];
  terminalCommands: string[];
  gitMarkers: RegExp[];
  defaultModel: string | null;
  chatSidebarSchemes: string[];
  configFiles: string[];
}

const KNOWN_AI_TOOLS: KnownAITool[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    cliProcesses: ['claude', 'claude-code'],
    extensionIds: ['anthropic.claude-code'],
    terminalCommands: ['claude', 'claude-code'],
    gitMarkers: [/@claude-code/i, /Co-Authored-By:\s*Claude/i, /Generated with Claude Code/i],
    defaultModel: 'claude-3-5-sonnet',
    chatSidebarSchemes: ['claude'],
    configFiles: ['.claude/CLAUDE.md', '.claude/settings.json'],
  },
  {
    name: 'opencode',
    displayName: 'OpenCode',
    cliProcesses: ['opencode'],
    extensionIds: [],
    terminalCommands: ['opencode'],
    gitMarkers: [/opencode/i, /Generated with OpenCode/i],
    defaultModel: null,
    chatSidebarSchemes: [],
    configFiles: ['.opencode/config.yaml', '.opencode/settings.json'],
  },
  {
    name: 'codex',
    displayName: 'OpenAI Codex',
    cliProcesses: ['codex', 'codex-cli'],
    extensionIds: [],
    terminalCommands: ['codex'],
    gitMarkers: [/codex/i, /Generated with Codex/i, /OpenAI Codex/i],
    defaultModel: null,
    chatSidebarSchemes: ['openai-codex'],
    configFiles: [],
  },
  {
    name: 'copilot',
    displayName: 'GitHub Copilot',
    cliProcesses: [],
    extensionIds: ['github.copilot', 'github.copilot-chat'],
    terminalCommands: [],
    gitMarkers: [/GitHub Copilot/i, /Copilot/i],
    defaultModel: null,
    chatSidebarSchemes: ['vscode-chat-code-block'],
    configFiles: [],
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    cliProcesses: [],
    extensionIds: [],
    terminalCommands: [],
    gitMarkers: [/Cursor AI/i, /Cursor/i],
    defaultModel: null,
    chatSidebarSchemes: [],
    configFiles: [],
  },
  {
    name: 'continue',
    displayName: 'Continue',
    cliProcesses: [],
    extensionIds: ['continue.continue'],
    terminalCommands: [],
    gitMarkers: [/continue\.dev/i, /Continue/i],
    defaultModel: null,
    chatSidebarSchemes: [],
    configFiles: [],
  },
  {
    name: 'codeium',
    displayName: 'Codeium',
    cliProcesses: [],
    extensionIds: ['codeium.codeium'],
    terminalCommands: [],
    gitMarkers: [/Codeium/i],
    defaultModel: null,
    chatSidebarSchemes: [],
    configFiles: [],
  },
];

export class AIToolDetector {
  private enabled: boolean;
  private scanProcesses: boolean;
  private readToolConfigs: boolean;
  private lastDetectedTool: AIToolName = 'unknown';
  private lastDetectionTime = 0;
  private readonly DETECTION_COOLDOWN_MS = 30000;

  // Cached result of the last background process scan. detectTool() runs
  // synchronously inside the emit path, so shelling out to `tasklist`/`ps`
  // there would block the extension host on every tracked event. The scan
  // therefore runs on its own timer and detectTool() only reads this cache.
  private processScan: { at: number; tools: AIToolName[] } = { at: 0, tools: [] };
  private processScanTimer: NodeJS.Timeout | null = null;
  private readonly PROCESS_SCAN_INTERVAL_MS = 20000;
  private readonly PROCESS_SCAN_TTL_MS = 60000;

  constructor(options: {
    enabled?: boolean;
    scanProcesses?: boolean;
    watchTerminal?: boolean;
    readToolConfigs?: boolean;
  } = {}) {
    this.enabled = options.enabled ?? true;
    this.scanProcesses = options.scanProcesses ?? true;
    this.readToolConfigs = options.readToolConfigs ?? false;
  }

  updateConfig(options: {
    enabled?: boolean;
    scanProcesses?: boolean;
    watchTerminal?: boolean;
    readToolConfigs?: boolean;
  }): void {
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.scanProcesses !== undefined) {
      this.scanProcesses = options.scanProcesses;
      if (!this.scanProcesses) {
        this.stopProcessWatcher();
        this.processScan = { at: 0, tools: [] };
      } else if (this.enabled) {
        this.startProcessWatcher();
      }
    }
    if (options.readToolConfigs !== undefined) this.readToolConfigs = options.readToolConfigs;
    if (options.enabled !== undefined && this.enabled && this.scanProcesses) {
      this.startProcessWatcher();
    }
  }

  /**
   * Start the background process scan. Safe to call repeatedly.
   */
  startProcessWatcher(): void {
    if (!this.enabled || !this.scanProcesses || this.processScanTimer) {
      return;
    }
    const tick = () => {
      void this.refreshProcessScan();
    };
    tick();
    this.processScanTimer = setInterval(tick, this.PROCESS_SCAN_INTERVAL_MS);
    // Never hold the extension host open for a background poll.
    this.processScanTimer.unref?.();
  }

  stopProcessWatcher(): void {
    if (this.processScanTimer) {
      clearInterval(this.processScanTimer);
      this.processScanTimer = null;
    }
  }

  dispose(): void {
    this.stopProcessWatcher();
  }

  /**
   * Run one process scan and refresh the cache. Never throws.
   */
  async refreshProcessScan(): Promise<void> {
    if (!this.enabled || !this.scanProcesses) {
      return;
    }
    try {
      const tools = this.scanForRunningTools();
      this.processScan = { at: Date.now(), tools };
    } catch {
      this.processScan = { at: Date.now(), tools: [] };
    }
  }

  /**
   * AI tools whose CLI process was seen in the most recent scan, if the cache
   * is still fresh. Returns an empty list when scanning is off or stale.
   */
  private getRunningProcessTools(): AIToolName[] {
    if (!this.enabled || !this.scanProcesses) {
      return [];
    }
    const age = Date.now() - this.processScan.at;
    if (this.processScan.at === 0 || age > this.PROCESS_SCAN_TTL_MS) {
      return [];
    }
    return this.processScan.tools;
  }

  detectTool(context: {
    commitMessage?: string;
    diff?: string;
    uri?: vscode.Uri;
    terminalCommand?: string;
    activeExtensionIds?: string[];
  }): AIToolDetection {
    if (!this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    const now = Date.now();

    if (context.terminalCommand) {
      const result = this.detectFromTerminalCommand(context.terminalCommand);
      if (result.tool !== 'unknown') {
        this.lastDetectedTool = result.tool;
        this.lastDetectionTime = now;
        return result;
      }
    }

    if (context.commitMessage || context.diff) {
      const result = this.detectFromGitMarkers(context.commitMessage ?? '', context.diff ?? '');
      if (result.tool !== 'unknown') {
        this.lastDetectedTool = result.tool;
        this.lastDetectionTime = now;
        return result;
      }
    }

    if (context.uri) {
      const result = this.detectFromChatSidebar(context.uri);
      if (result.tool !== 'unknown') {
        this.lastDetectedTool = result.tool;
        this.lastDetectionTime = now;
        return result;
      }
    }

    // Consult the cached background process scan. This is the signal that
    // names agentic CLIs (opencode, claude, codex) while they are editing the
    // workspace, and it costs nothing on this synchronous path.
    const runningTools = this.getRunningProcessTools();
    if (runningTools.length > 0) {
      const best = runningTools[0];
      const model = this.detectModelForTool(best);
      this.lastDetectedTool = best;
      this.lastDetectionTime = now;
      return {
        tool: best,
        model,
        confidence: runningTools.length === 1 ? 'high' : 'medium',
        source: 'cli-process',
        estimated: model === null,
      };
    }

    const recentTool = this.getRecentlyDetectedTool(now);
    if (recentTool !== 'unknown') {
      return { tool: recentTool, model: null, confidence: 'low', source: 'default', estimated: true };
    }

    return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
  }

  /**
   * Shell out once and return the AI tools whose CLI is currently running.
   * Ordered most-specific first so a long match wins over a substring of it.
   */
  private scanForRunningTools(): AIToolName[] {
    let output = '';
    if (os.platform() === 'win32') {
      output = child_process
        .execSync('tasklist /FO CSV /NH', {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .toString();
    } else {
      output = child_process
        .execSync('ps -axo command', {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .toString();
    }

    const found = new Map<AIToolName, number>();

    for (const line of output.split('\n')) {
      const lower = line.toLowerCase();
      if (!lower.trim()) {
        continue;
      }
      for (const tool of KNOWN_AI_TOOLS) {
        for (const proc of tool.cliProcesses) {
          // Require the process name to appear as a path/executable segment
          // or at a word boundary, so `claude` does not match an unrelated
          // path like `/home/user/clauded-something/x`.
          const idx = lower.lastIndexOf(proc.toLowerCase());
          if (idx === -1) {
            continue;
          }
          const before = idx === 0 ? '' : lower[idx - 1];
          const after = lower[idx + proc.length] ?? '';
          const startsSegment = idx === 0 || /[\\/\\s"']/.test(before);
          const endsSegment = after === '' || /[\\/\\s"',.]/.test(after);
          if (startsSegment && endsSegment) {
            found.set(tool.name, Math.max(found.get(tool.name) ?? 0, proc.length));
          }
        }
      }
    }

    return Array.from(found.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  async detectFromProcesses(): Promise<AIToolDetection> {
    if (!this.scanProcesses || !this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    let tools: AIToolName[];
    try {
      tools = this.scanForRunningTools();
    } catch {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    if (tools.length === 0) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    const best = tools[0];
    const model = this.detectModelForTool(best);

    return {
      tool: best,
      model,
      confidence: tools.length === 1 ? 'high' : 'medium',
      source: 'cli-process',
      estimated: model === null,
    };
  }

  detectFromExtensions(extensionIds: string[]): AIToolDetection {
    if (!this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    const detected: Array<{ tool: KnownAITool; matchedIds: string[] }> = [];

    for (const tool of KNOWN_AI_TOOLS) {
      const matched = tool.extensionIds.filter((id) => extensionIds.includes(id));
      if (matched.length > 0) {
        detected.push({ tool, matchedIds: matched });
      }
    }

    if (detected.length === 0) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    detected.sort((a, b) => b.matchedIds.length - a.matchedIds.length);
    const best = detected[0].tool;
    const model = this.detectModelForTool(best.name);

    return {
      tool: best.name,
      model,
      confidence: 'high',
      source: 'extension',
      estimated: model === null,
    };
  }

  detectFromTerminalCommand(command: string): AIToolDetection {
    if (!this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    const lower = command.toLowerCase().trim();

    for (const tool of KNOWN_AI_TOOLS) {
      for (const cmd of tool.terminalCommands) {
        if (lower === cmd.toLowerCase() || lower.startsWith(cmd.toLowerCase() + ' ') || lower.startsWith(cmd.toLowerCase() + '\t')) {
          const model = this.detectModelForTool(tool.name);
          return {
            tool: tool.name,
            model,
            confidence: 'high',
            source: 'terminal',
            estimated: model === null,
          };
        }
      }
    }

    return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
  }

  detectFromGitMarkers(commitMessage: string, diff: string): AIToolDetection {
    if (!this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    const combined = `${commitMessage}\n${diff}`;

    for (const tool of KNOWN_AI_TOOLS) {
      for (const marker of tool.gitMarkers) {
        if (marker.test(combined)) {
          const model = this.extractModelFromCommit(commitMessage) || this.detectModelForTool(tool.name);
          return {
            tool: tool.name,
            model,
            confidence: 'high',
            source: 'git-marker',
            estimated: model === null,
          };
        }
      }
    }

    return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
  }

  detectFromChatSidebar(uri: vscode.Uri): AIToolDetection {
    if (!this.enabled) {
      return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
    }

    for (const tool of KNOWN_AI_TOOLS) {
      for (const scheme of tool.chatSidebarSchemes) {
        if (uri.scheme === scheme || (uri.fsPath && uri.fsPath.toLowerCase().includes(scheme))) {
          const model = this.detectModelForTool(tool.name);
          return {
            tool: tool.name,
            model,
            confidence: 'high',
            source: 'chat-sidebar',
            estimated: model === null,
          };
        }
      }
    }

    return { tool: 'unknown', model: null, confidence: 'low', source: 'default', estimated: true };
  }

  detectFromToolConfig(toolName: AIToolName): string | null {
    if (!this.readToolConfigs || !this.enabled) {
      return null;
    }

    const tool = KNOWN_AI_TOOLS.find((t) => t.name === toolName);
    if (!tool || tool.configFiles.length === 0) {
      return null;
    }

    const home = os.homedir();
    for (const configFile of tool.configFiles) {
      const configPath = path.join(home, configFile);
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          const model = this.extractModelFromConfig(content);
          if (model) {
            return model;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  getKnownTools(): KnownAITool[] {
    return KNOWN_AI_TOOLS;
  }

  getToolByName(name: AIToolName): KnownAITool | undefined {
    return KNOWN_AI_TOOLS.find((t) => t.name === name);
  }

  private getRecentlyDetectedTool(now: number): AIToolName {
    if (now - this.lastDetectionTime <= this.DETECTION_COOLDOWN_MS) {
      return this.lastDetectedTool;
    }
    return 'unknown';
  }

  private detectModelForTool(toolName: AIToolName): string | null {
    const tool = KNOWN_AI_TOOLS.find((t) => t.name === toolName);
    return tool ? tool.defaultModel : null;
  }

  private extractModelFromCommit(commitMessage: string): string | null {
    const patterns = [
      /model[:=]\s*([\w-]+)/i,
      /claude-(\d[\w-]*)/i,
      /gpt-(\d[\w-]*)/i,
      /sonnet/i,
      /opus/i,
      /haiku/i,
    ];

    for (const pattern of patterns) {
      const match = commitMessage.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return null;
  }

  private extractModelFromConfig(content: string): string | null {
    const patterns = [
      /(?:default_model|model)[:\s=]+\s*["']?([\w./-]+)["']?/i,
      /claude-(\d[\w-]*)/i,
      /gpt-(\d[\w-]*)/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1] || match[0];
      }
    }

    return null;
  }

  static toolToAIToolEnum(tool: AIToolName): AITool | string {
    const map: Record<AIToolName, AITool | string> = {
      copilot: AITool.Copilot,
      cursor: AITool.Cursor,
      'claude-code': AITool.ClaudeCode,
      opencode: 'opencode',
      codex: 'codex',
      continue: 'continue',
      codeium: 'codeium',
      unknown: 'unknown',
    };
    return map[tool];
  }
}

export function getDefaultAIToolDetector(): AIToolDetector {
  return new AIToolDetector({
    enabled: true,
    scanProcesses: true,
    watchTerminal: false,
    readToolConfigs: false,
  });
}
