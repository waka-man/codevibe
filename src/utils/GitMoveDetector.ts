/**
 * GitMoveDetector - recognises pure file moves that Git reports as either
 * "deleted old path + untracked new path" or a staged rename.
 *
 * A path-scoped `git diff HEAD` cannot see an unstaged destination and can
 * misread a staged rename as a new file. Compare the destination's Git blob
 * hash with tracked source content to identify a content-preserving move.
 */

import * as path from 'path';

function git(
  workspaceFolder: string,
  args: string[],
): string {
  const { execFileSync } = require('child_process');
  return String(
    execFileSync('git', args, {
      cwd: workspaceFolder,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }) ?? '',
  );
}

/**
 * Return the absolute tracked source path whose content matches `filePath`,
 * or null when this is not a pure move. All commands use argument arrays, so spaces,
 * quotes, and shell metacharacters in paths remain literal.
 */
export function findGitMoveSource(
  workspaceFolder: string,
  filePath: string,
): string | null {
  const workspaceRelativePath = path
    .relative(workspaceFolder, filePath)
    .split(path.sep)
    .join('/');
  if (
    !workspaceRelativePath ||
    workspaceRelativePath === '..' ||
    workspaceRelativePath.startsWith('../') ||
    path.isAbsolute(workspaceRelativePath)
  ) {
    return null;
  }

  try {
    const repoRoot = git(workspaceFolder, [
      'rev-parse',
      '--show-toplevel',
    ]).trim();
    const relativePath = path
      .relative(repoRoot, filePath)
      .split(path.sep)
      .join('/');

    // --path applies the same clean filters / line-ending rules Git would use
    // for this destination, so CRLF and filtered files compare correctly.
    const destinationHash = git(workspaceFolder, [
      'hash-object',
      `--path=${relativePath}`,
      '--',
      filePath,
    ]).trim();

    // Staged moves are already renames in the index. Only accept R100 and
    // verify the working file still matches the staged destination blob, so
    // an unstaged edit after `git mv` is not hidden.
    const stagedChanges = git(workspaceFolder, [
      'diff',
      '--cached',
      '--name-status',
      '-M',
      '-z',
      'HEAD',
      '--',
    ]).split('\0').filter(Boolean);
    for (let i = 0; i < stagedChanges.length; i++) {
      const status = stagedChanges[i];
      if (!status.startsWith('R')) {
        continue;
      }
      const sourcePath = stagedChanges[i + 1];
      const stagedPath = stagedChanges[i + 2];
      i += 2;
      if (status !== 'R100' || stagedPath !== relativePath) {
        continue;
      }
      const stagedHash = git(workspaceFolder, [
        'rev-parse',
        `:${relativePath}`,
      ]).trim();
      if (stagedHash === destinationHash) {
        return path.join(repoRoot, ...sourcePath.split('/'));
      }
    }

    // Unstaged moves: --full-name keeps paths repository-root relative even
    // when the workspace is a subdirectory. --stage supplies the source blob
    // ID directly, avoiding one Git process per deleted file.
    const deletedEntries = git(workspaceFolder, [
      'ls-files',
      '--stage',
      '--deleted',
      '--full-name',
      '-z',
    ]).split('\0').filter(Boolean);

    for (const entry of deletedEntries) {
      const separator = entry.indexOf('\t');
      if (separator < 0) {
        continue;
      }
      const header = entry.slice(0, separator);
      const deletedPath = entry.slice(separator + 1);
      const blobHash = /^\d+ ([0-9a-f]+) \d+$/.exec(header)?.[1];
      // Git cannot correlate an untracked destination by itself. Require the
      // same basename as corroborating evidence so an unrelated deleted file
      // with identical bytes cannot suppress genuine agent output.
      const sameBasename =
        path.posix.basename(deletedPath) === path.posix.basename(relativePath);
      if (sameBasename && blobHash === destinationHash) {
        return path.join(repoRoot, ...deletedPath.split('/'));
      }
    }
  } catch {
    // Not a Git repo, git unavailable, or an unreadable path: fail open and
    // retain the existing agent-detection behaviour.
  }

  return null;
}
