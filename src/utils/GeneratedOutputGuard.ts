/**
 * GeneratedOutputGuard - prevents CodeVibe's own exports from being tracked
 * as user/AI source code during the current extension session.
 *
 * Exporters register the exact destination before writing and roll the
 * registration back if the write fails. Registrations are deliberately not
 * used by historical purge/reconciliation code: a transient runtime guard must
 * never authorise deleting pre-existing evidence.
 */

interface OutputTarget {
  fsPath?: string;
  scheme?: string;
  toString?: () => string;
}

const registeredOutputs = new Set<string>();

function normalize(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function targetKeys(target: OutputTarget | string | null | undefined): string[] {
  if (!target) {
    return [];
  }
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

/**
 * Register an exact export destination before writing it.
 * Returns a rollback function for failed writes.
 */
export function registerGeneratedOutput(target: OutputTarget | string): () => void {
  const keys = targetKeys(target).filter(Boolean);
  for (const key of keys) {
    registeredOutputs.add(key);
  }
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const key of keys) {
      registeredOutputs.delete(key);
    }
  };
}

/** True only for exact destinations registered in this extension session. */
export function isGeneratedOutput(
  target: OutputTarget | string | null | undefined,
): boolean {
  return targetKeys(target).some((key) => registeredOutputs.has(key));
}

/** Clear exact registrations (extension shutdown/tests). */
export function clearGeneratedOutputs(): void {
  registeredOutputs.clear();
}
