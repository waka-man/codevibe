/**
 * GeneratedOutputGuard - prevents CodeVibe's own exports from being tracked
 * as user/AI source code.
 *
 * Exporters register the exact target before writing. Known output filenames
 * are also recognised after a reload, when the in-memory registry is empty.
 */

interface OutputTarget {
  fsPath?: string;
  toString?: () => string;
}

const registeredOutputs = new Set<string>();

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function targetKeys(target: OutputTarget | string): string[] {
  if (typeof target === 'string') {
    return [normalize(target)];
  }
  const keys: string[] = [];
  if (target.fsPath) {
    keys.push(normalize(target.fsPath));
  }
  if (
    typeof target.toString === 'function' &&
    target.toString !== Object.prototype.toString
  ) {
    keys.push(normalize(target.toString()));
  }
  return keys;
}

/** Register an exact export destination before writing it. */
export function registerGeneratedOutput(target: OutputTarget | string): void {
  for (const key of targetKeys(target)) {
    if (key) {
      registeredOutputs.add(key);
    }
  }
}

/** True for registered destinations and known CodeVibe export filenames. */
export function isGeneratedOutput(target: OutputTarget | string): boolean {
  const keys = targetKeys(target);
  if (keys.some((key) => registeredOutputs.has(key))) {
    return true;
  }

  const filePath = typeof target === 'string' ? target : target.fsPath;
  if (!filePath) {
    return false;
  }
  const basename = normalize(filePath).split('/').pop() ?? '';
  return (
    basename.endsWith('.report.json') ||
    /^codepause-(?:export|metrics)-.*\.json$/.test(basename) ||
    basename === 'codepause-config.json'
  );
}

/** Clear exact registrations (extension shutdown/tests). Filename rules remain. */
export function clearGeneratedOutputs(): void {
  registeredOutputs.clear();
}
