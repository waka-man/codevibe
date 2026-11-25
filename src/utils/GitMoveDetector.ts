/**
 * GitMoveDetector - recognises pure file moves that Git currently reports as
 * "deleted old path + untracked new path".
 *
 * VS Code moves files in the working tree without staging them. A path-scoped
 * `git diff HEAD` therefore cannot see the rename and the new path looks like
 * brand-new agent output. Compare the new file's Git blob hash with tracked
 * files deleted from the working tree to identify a content-preserving move.
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
    }) ?? '',
  );
}

/**
 * Return the deleted tracked path whose committed content matches `filePath`,
 * or null when this is not a pure move. All commands use argument arrays, so
 * spaces, quotes, and shell metacharacters in paths remain literal.
 */
export function findGitMoveSource(
  workspaceFolder: string,
  filePath: string,
): string | null {
  const relativePath = path
    .relative(workspaceFolder, filePath)
    .split(path.sep)
    .join('/');
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  try {
    const deletedPaths = git(workspaceFolder, [
      'ls-files',
      '--deleted',
      '-z',
    ])
      .split('\0')
      .filter(Boolean);
    if (deletedPaths.length === 0) {
      return null;
    }

    // --path applies the same clean filters / line-ending rules Git would use
    // for this destination, so CRLF and filtered files compare correctly.
    const destinationHash = git(workspaceFolder, [
      'hash-object',
      `--path=${relativePath}`,
      '--',
      filePath,
    ]).trim();

    for (const deletedPath of deletedPaths) {
      const sourceHash = git(workspaceFolder, [
        'rev-parse',
        `HEAD:${deletedPath}`,
      ]).trim();
      if (sourceHash === destinationHash) {
        return deletedPath;
      }
    }
  } catch {
    // Not a Git repo, git unavailable, or an unreadable path: fail open and
    // retain the existing agent-detection behaviour.
  }

  return null;
}
