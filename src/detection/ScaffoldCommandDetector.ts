/**
 * ScaffoldCommandDetector - recognises project scaffolding commands run in
 * the VS Code terminal (`npx sv create`, `npm create vite`, `ng new`, ...).
 *
 * WHY THIS EXISTS:
 * Scaffolders write many brand-new, untracked source files to disk while
 * those files are closed. The file watcher treats closed-file writes as AI
 * agent mode, so a fresh boilerplate project was reported as AI-authored.
 * While a known scaffolder is running (plus a short grace period for late
 * watcher events), external file writes are attributed to the tool, not AI.
 *
 * Deliberately narrow: only one-shot generators are listed. Long-running
 * dev servers (`pnpm dev`) are NOT, since suppressing AI detection for a whole
 * dev session would hide real agent writes; their output dirs are handled by
 * the generated-path ignore list and the git-ignore check instead.
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
  return SCAFFOLD_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Tracks running scaffold commands. `isActive()` stays true while any is
 * running and for `graceMs` after the last one ends (watcher events lag).
 */
export class ScaffoldActivityTracker {
  private readonly running = new Set<unknown>();
  private lastEndedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly graceMs: number = 10_000) {}

  /** Record a terminal command start; returns true if it is a scaffolder. */
  start(key: unknown, commandLine: string | undefined | null): boolean {
    if (!isScaffoldCommand(commandLine)) {
      return false;
    }
    this.running.add(key);
    return true;
  }

  end(key: unknown, now: number = Date.now()): void {
    if (this.running.delete(key)) {
      this.lastEndedAt = now;
    }
  }

  isActive(now: number = Date.now()): boolean {
    return this.running.size > 0 || now - this.lastEndedAt <= this.graceMs;
  }
}
