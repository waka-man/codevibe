/**
 * ScaffoldCommandDetector - recognises project scaffolding commands run in
 * the VS Code terminal (`npx sv create`, `npm create vite`, `ng new`, ...).
 *
 * WHY THIS EXISTS:
 * Scaffolders write many brand-new, untracked source files to disk while
 * those files are closed. The file watcher treats closed-file writes as AI
 * agent mode, so a fresh boilerplate project was reported as AI-authored.
 * While a known scaffolder is running (plus a short grace period for late
 * watcher events), newly created files inside its parsed target directory
 * are attributed to the tool, not AI.
 *
 * Deliberately narrow: only simple, one-shot generator commands are listed.
 * Compound commands, command substitution, long-running dev servers, and
 * unknown target layouts are not suppressed. This avoids hiding unrelated
 * agent writes; generated output directories are handled by the hard-ignore
 * list instead.
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

/** Reject shell composition/substitution unless it is inside quotes. */
function hasUnquotedShellOperator(commandLine: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (
        quote !== "'" &&
        (char === '`' || (char === '$' && commandLine[i + 1] === '('))
      ) {
        return true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/[;&|\n\r`]/.test(char) || (char === '$' && commandLine[i + 1] === '(')) {
      return true;
    }
  }
  return false;
}

/** Tokenise a simple command while respecting quotes and escapes. */
function tokenizeCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  const push = (): void => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    started = true;
  }

  if (quote || escaped) {
    return [];
  }
  push();
  return tokens;
}

/** True if the command line is a simple, known project scaffold command. */
export function isScaffoldCommand(commandLine: string | undefined | null): boolean {
  if (!commandLine || hasUnquotedShellOperator(commandLine)) {
    return false;
  }
  const normalized = commandLine.trim().toLowerCase();
  return SCAFFOLD_PATTERNS.some((pattern) => pattern.exec(normalized)?.index === 0);
}

function firstPositional(args: readonly string[]): string {
  for (const arg of args) {
    if (arg === '--') {
      break;
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return '.';
}

function safeTarget(target: string): string | null {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }
  return normalized;
}

/** Parse the directory a simple scaffolder writes into, relative to cwd. */
function scaffoldTarget(commandLine: string): string | null {
  const tokens = tokenizeCommand(commandLine);
  if (tokens.length < 2) {
    return null;
  }
  const executable = tokens[0].split('/').pop()?.toLowerCase() ?? '';
  const args = tokens.slice(1);

  if (['npx', 'bunx', 'pnpx'].includes(executable)) {
    while (args[0]?.startsWith('-')) {
      args.shift();
    }
    const pkg = args.shift()?.toLowerCase() ?? '';
    if (/^(?:sv|nuxi|@angular\/cli|@nestjs\/cli|@vue\/cli)(?:@|$)/.test(pkg)) {
      args.shift(); // create/new/init
      return safeTarget(firstPositional(args));
    }
    if (/^(?:create-[\w.-]+|@[\w.-]+\/create[\w.-]*|degit|tiged|giget)(?:@|$)/.test(pkg)) {
      if (['degit', 'tiged', 'giget'].some((name) => pkg.startsWith(name))) {
        args.shift(); // source repository
      }
      return safeTarget(firstPositional(args));
    }
    return null;
  }

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const subcommand = args.shift()?.toLowerCase();
    if (subcommand === 'dlx') {
      while (args[0]?.startsWith('-')) {
        args.shift();
      }
      const pkg = args.shift()?.toLowerCase() ?? '';
      if (!/^(?:create-[\w.-]+|@[\w.-]+\/create[\w.-]*|degit|tiged|giget)(?:@|$)/.test(pkg)) {
        return null;
      }
      if (['degit', 'tiged', 'giget'].some((name) => pkg.startsWith(name))) {
        args.shift();
      }
      return safeTarget(firstPositional(args));
    }
    if (subcommand !== 'create' && subcommand !== 'init') {
      return null;
    }
    args.shift(); // generator package, e.g. vite@latest
    return safeTarget(firstPositional(args));
  }

  if (executable === 'git') {
    if (args.shift()?.toLowerCase() !== 'clone') {
      return null;
    }
    while (args[0]?.startsWith('-')) {
      args.shift();
    }
    const repository = args.shift();
    if (!repository) {
      return null;
    }
    const explicitTarget = firstPositional(args);
    if (explicitTarget !== '.') {
      return safeTarget(explicitTarget);
    }
    const derived = repository.replace(/\/$/, '').split('/').pop()?.replace(/\.git$/i, '');
    return derived ? safeTarget(derived) : null;
  }

  if (executable === 'dotnet') {
    if (args.shift()?.toLowerCase() !== 'new') {
      return null;
    }
    const outputIndex = args.findIndex(
      (arg) => arg === '-o' || arg === '--output',
    );
    return safeTarget(outputIndex >= 0 ? args[outputIndex + 1] ?? '.' : '.');
  }

  if (executable === 'composer') {
    if (args.shift()?.toLowerCase() !== 'create-project') {
      return null;
    }
    args.shift(); // vendor/package
    return safeTarget(firstPositional(args));
  }

  if (executable.startsWith('python') && args[0] === 'manage.py') {
    args.shift();
    const subcommand = args.shift()?.toLowerCase();
    if (subcommand !== 'startapp' && subcommand !== 'startproject') {
      return null;
    }
    return safeTarget(firstPositional(args));
  }

  const subcommand = args.shift()?.toLowerCase();
  const takesTarget =
    (['ng', 'nest'].includes(executable) && subcommand === 'new') ||
    (['vue', 'sv', 'nuxi', 'rails', 'flutter', 'laravel'].includes(executable) &&
      ['create', 'init', 'new'].includes(subcommand ?? '')) ||
    (executable === 'django-admin' &&
      ['startproject', 'startapp'].includes(subcommand ?? '')) ||
    (executable === 'cargo' && ['new', 'init', 'generate'].includes(subcommand ?? ''));
  if (takesTarget) {
    return safeTarget(firstPositional(args));
  }
  if (executable === 'go' && subcommand === 'mod' && args[0] === 'init') {
    return '.';
  }
  return null;
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
 * Tracks running scaffold commands. Suppression is limited to newly created
 * files under the parsed target directory and bounded by `maxRunningMs`.
 */
export class ScaffoldActivityTracker {
  private readonly running = new Map<unknown, RunningScaffold>();
  private readonly recentlyEnded = new Map<string, number>();

  constructor(
    private readonly graceMs: number = 10_000,
    private readonly maxRunningMs: number = 5 * 60_000,
  ) {}

  /** Record a terminal command start; returns true if it is safely scopeable. */
  start(
    key: unknown,
    commandLine: string | undefined | null,
    rootPath?: string,
    now: number = Date.now(),
  ): boolean {
    if (!rootPath || !commandLine || !isScaffoldCommand(commandLine)) {
      return false;
    }
    const target = scaffoldTarget(commandLine);
    if (target === null) {
      return false;
    }
    const cwd = normalizePath(rootPath);
    const scopedRoot = target === '.' ? cwd : `${cwd}/${target}`;
    this.running.set(key, { rootPath: scopedRoot, startedAt: now });
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

  /** True only for newly created files inside a scaffolder's target directory. */
  isActiveFor(
    filePath: string,
    newlyCreated: boolean,
    now: number = Date.now(),
  ): boolean {
    if (!newlyCreated) {
      return false;
    }
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
