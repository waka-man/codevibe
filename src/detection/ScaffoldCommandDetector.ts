/**
 * ScaffoldCommandDetector - recognises project scaffolding commands run in
 * the VS Code terminal (`npx sv create`, `npm create vite`, `ng new`, ...).
 *
 * WHY THIS EXISTS:
 * Scaffolders write many brand-new, untracked source files to disk while
 * those files are closed. The file watcher treats closed-file writes as AI
 * agent mode, so a fresh boilerplate project was reported as AI-authored.
 * While a known scaffolder is running (plus a short grace period for late
 * watcher events), external file writes inside that terminal's working
 * directory are attributed to the tool, not AI.
 *
 * Deliberately narrow: only one-shot generators are listed. Long-running
 * dev servers (`pnpm dev`) are NOT, since suppressing AI detection for a whole
 * dev session would hide real agent writes; their output dirs are handled by
 * the generated-path ignore list instead.
 *
 * Dependency-free (no vscode import) so it is unit-testable.
 */

const SCAFFOLD_PATTERNS: readonly RegExp[] = [
  // npm/pnpm/yarn/bun create <x> | init <x>
  /\b(?:npm|pnpm|yarn|bun)\s+(?:create|init)\b/,
  // npm exec / pnpm dlx / yarn dlx / bunx / npx running a generator
  /\b(?:npx|bunx|pnpx|(?:pnpm|yarn)\s+dlx|npm\s+exec)\s+(?:-\S+\s+)*(?:sv(?:@\S+)?\s+create|create-[\w.-]+|@[\w.-]+\/create[\w.-]*|degit|tiged|giget|nuxi(?:@\S+)?\s+(?:init|create)|@angular\/cli(?:@\S+)?\s+new|@nestjs\/cli(?:@\S+)?\s+new|@vue\/cli(?:@\S+)?\s+create)/,
  // Framework CLIs
  /\bng\s+new\b/,
  /\bnest\s+new\b/,
  /\bvue\s+create\b/,
  /\bnuxi\s+(?:init|create)\b/,
  /\bsv\s+create\b/,
  /\brails\s+new\b/,
  /\bdjango-admin\s+startproject\b/,
  /\b(?:python\d?\s+manage\.py|django-admin)\s+startapp\b/,
  /\bcargo\s+(?:new|init|generate)\b/,
  /\bdotnet\s+new\b/,
  /\bflutter\s+create\b/,
  /\bcomposer\s+create-project\b/,
  /\blaravel\s+new\b/,
  /\bgo\s+mod\s+init\b/,
  /\bgit\s+clone\b/,
];

/** True if the command line runs a known project scaffolding tool. */
export function isScaffoldCommand(commandLine: string | undefined | null): boolean {
  if (!commandLine) {
    return false;
  }
  const normalized = commandLine.trim().toLowerCase();
  // Only inspect actual shell-command segments. Searching the whole line
  // would misclassify commands such as `echo "npx sv create"` and suppress
  // unrelated AI detection. Compound commands such as
  // `cd app && npx sv create demo` are still recognised.
  const segments = normalized.split(/(?:&&|\|\||;)/);
  return segments.some((rawSegment) => {
    const segment = rawSegment.trim();
    return SCAFFOLD_PATTERNS.some((pattern) => pattern.exec(segment)?.index === 0);
  });
}

function normalizePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return (normalized || '/').toLowerCase();
}

function isWithin(rootPath: string, filePath: string): boolean {
  const root = normalizePath(rootPath);
  const file = normalizePath(filePath);
  if (root === '/') {
    return file.startsWith('/');
  }
  return file === root || file.startsWith(`${root}/`);
}

interface RunningScaffold {
  rootPath: string;
  startedAt: number;
}

/**
 * Tracks running scaffold commands. Suppression is scoped to the terminal's
 * working directory and bounded by `maxRunningMs`, so a generator waiting for
 * input cannot blind AI detection indefinitely.
 */
export class ScaffoldActivityTracker {
  private readonly running = new Map<unknown, RunningScaffold>();
  private readonly recentlyEnded = new Map<string, number>();

  constructor(
    private readonly graceMs: number = 10_000,
    private readonly maxRunningMs: number = 5 * 60_000,
  ) {}

  /** Record a terminal command start; returns true if it is a safely scoped scaffolder. */
  start(
    key: unknown,
    commandLine: string | undefined | null,
    rootPath?: string,
    now: number = Date.now(),
  ): boolean {
    if (!isScaffoldCommand(commandLine) || !rootPath) {
      return false;
    }
    this.running.set(key, { rootPath, startedAt: now });
    return true;
  }

  end(key: unknown, now: number = Date.now()): void {
    const running = this.running.get(key);
    if (running) {
      this.running.delete(key);
      this.recentlyEnded.set(normalizePath(running.rootPath), now);
    }
  }

  /** True while any safely scoped scaffolder is running or recently ended. */
  isActive(now: number = Date.now()): boolean {
    this.removeExpired(now);
    return this.running.size > 0 || [...this.recentlyEnded.values()]
      .some((endedAt) => now - endedAt <= this.graceMs);
  }

  /** True only for files inside a running/recently-ended scaffolder's cwd. */
  isActiveFor(filePath: string, now: number = Date.now()): boolean {
    this.removeExpired(now);
    for (const { rootPath } of this.running.values()) {
      if (isWithin(rootPath, filePath)) {
        return true;
      }
    }
    for (const [rootPath, endedAt] of this.recentlyEnded) {
      if (now - endedAt <= this.graceMs && isWithin(rootPath, filePath)) {
        return true;
      }
    }
    return false;
  }

  private removeExpired(now: number): void {
    for (const [key, running] of this.running) {
      if (now - running.startedAt > this.maxRunningMs) {
        this.running.delete(key);
      }
    }
    for (const [rootPath, endedAt] of this.recentlyEnded) {
      if (now - endedAt > this.graceMs) {
        this.recentlyEnded.delete(rootPath);
      }
    }
  }
}
