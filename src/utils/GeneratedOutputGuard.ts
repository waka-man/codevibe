/**
 * GeneratedOutputGuard - prevents CodeVibe's own exports from being tracked
 * as user/AI source code during the write and subsequent watcher window.
 *
 * Exporters register the exact destination before writing. Failed writes roll
 * back immediately; successful writes keep the guard briefly so deferred file
 * watcher events are ignored, then expire so the path can become source again.
 * Registrations are deliberately not used by historical purge, query, or
 * assignment-report code: transient runtime state must never hide or delete
 * pre-existing evidence.
 */

interface OutputTarget {
  fsPath?: string;
  scheme?: string;
  toString?: () => string;
}

interface OutputRegistration {
  expiresAt: number | null;
}

export interface GeneratedOutputRegistration {
  /** Remove this write's protection immediately. */
  rollback: () => void;
  /** Keep protection through the watcher window, then let it expire. */
  complete: () => void;
}

// Must exceed UnifiedAITracker's 5-second deferred watcher recheck, with room
// for a create/change burst. Completed registrations expire without timers.
const GENERATED_OUTPUT_GUARD_WINDOW_MS = 15_000;

const registeredOutputs = new Map<string, Set<OutputRegistration>>();

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

function pruneExpired(now: number = Date.now()): void {
  for (const [key, registrations] of registeredOutputs) {
    for (const registration of registrations) {
      if (
        registration.expiresAt !== null &&
        registration.expiresAt <= now
      ) {
        registrations.delete(registration);
      }
    }
    if (registrations.size === 0) {
      registeredOutputs.delete(key);
    }
  }
}

/**
 * Register an exact export destination before writing it.
 * Call rollback() if the write fails or complete() once it succeeds.
 */
export function registerGeneratedOutput(
  target: OutputTarget | string,
): GeneratedOutputRegistration {
  pruneExpired();
  const keys = new Set(targetKeys(target).filter(Boolean));
  const registration: OutputRegistration = { expiresAt: null };
  for (const key of keys) {
    const registrations =
      registeredOutputs.get(key) ?? new Set<OutputRegistration>();
    registrations.add(registration);
    registeredOutputs.set(key, registrations);
  }

  let active = true;
  const rollback = (): void => {
    if (!active) {
      return;
    }
    active = false;
    for (const key of keys) {
      const registrations = registeredOutputs.get(key);
      registrations?.delete(registration);
      if (registrations?.size === 0) {
        registeredOutputs.delete(key);
      }
    }
  };

  return {
    rollback,
    complete: (): void => {
      if (!active || registration.expiresAt !== null) {
        return;
      }
      registration.expiresAt = Date.now() + GENERATED_OUTPUT_GUARD_WINDOW_MS;
    },
  };
}

/** True only for exact destinations in their active write/watcher window. */
export function isGeneratedOutput(
  target: OutputTarget | string | null | undefined,
): boolean {
  pruneExpired();
  return targetKeys(target).some(
    (key) => (registeredOutputs.get(key)?.size ?? 0) > 0,
  );
}

/** Clear exact registrations (extension shutdown/tests). */
export function clearGeneratedOutputs(): void {
  registeredOutputs.clear();
}
