/**
 * GitMoveDetector - recognises pure file moves that Git reports as either
 * "deleted old path + untracked new path" or a staged rename.
 *
 * A path-scoped `git diff HEAD` cannot see an unstaged destination and can
 * misread a staged rename as a new file. Compare the destination's Git blob
 * hash with tracked source content to identify a content-preserving move.
 */

import * as fs from 'fs';
import * as path from 'path';

function git(
  workspaceFolder: string,
  args: string[],
  cwd: string = workspaceFolder,
): string {
  const { execFileSync } = require('child_process');
  return String(
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }) ?? '',
  );
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/** Resolve a repository-relative source through the workspace's own path. */
function resolveWorkspaceSource(
  workspaceFolder: string,
  workspaceRepoPath: string,
  sourceRepoPath: string,
): string | null {
  const relativeToWorkspace = path.posix.relative(workspaceRepoPath, sourceRepoPath);
  if (
    !relativeToWorkspace ||
    relativeToWorkspace === '..' ||
    relativeToWorkspace.startsWith('../') ||
    path.posix.isAbsolute(relativeToWorkspace)
  ) {
    return null;
  }
  return path.join(workspaceFolder, ...relativeToWorkspace.split('/'));
}

/**
 * Return the absolute tracked source path whose content matches `filePath`,
 * or null when this is not a pure move. All commands use argument arrays, so
 * spaces, quotes, and shell metacharacters in paths remain literal.
 */
export function findGitMoveSource(
  workspaceFolder: string,
  filePath: string,
): string | null {
  const workspaceRelativePath = toPosix(path.relative(workspaceFolder, filePath));
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
    const workspaceRepoPath =
      git(workspaceFolder, ['rev-parse', '--show-prefix']).trim().replace(/\/+$/, '') || '.';
    const relativePath = path.posix.normalize(
      workspaceRepoPath === '.'
        ? workspaceRelativePath
        : `${workspaceRepoPath}/${workspaceRelativePath}`,
    );

    // --path applies the same clean filters / line-ending rules Git would use
    // for this destination, so CRLF and filtered files compare correctly.
    const destinationHash = git(workspaceFolder, [
      'hash-object',
      `--path=${relativePath}`,
      '--',
      filePath,
    ]).trim();

    // A staged move appears as a staged deletion plus a staged destination.
    // Compare the working file with the index destination first, then with
    // same-basename sources deleted from HEAD. This avoids parsing platform-
    // specific rename-status output and still proves a content-preserving move.
    let stagedHash: string | null = null;
    try {
      stagedHash = git(workspaceFolder, [
        'rev-parse',
        `:${relativePath}`,
      ]).trim();
    } catch {
      // Destination is not staged.
    }
    if (stagedHash === destinationHash) {
      // Raw deletion records include the old blob hash, so bulk staged moves
      // need one Git process rather than one `rev-parse` per deleted source.
      const rawDeletions = git(workspaceFolder, [
        'diff',
        '--cached',
        '--raw',
        '--abbrev=40',
        '--no-renames',
        '--diff-filter=D',
        '-z',
        'HEAD',
        '--',
      ]).split('\0').filter(Boolean);
      for (let i = 0; i + 1 < rawDeletions.length; i += 2) {
        const header = rawDeletions[i];
        const sourcePath = rawDeletions[i + 1];
        const sourceHash = /^:\d+ \d+ ([0-9a-f]+) 0+ D$/.exec(header)?.[1];
        if (sourceHash !== destinationHash) {
          continue;
        }
        const sourceAbsolutePath = resolveWorkspaceSource(
          workspaceFolder,
          workspaceRepoPath,
          sourcePath,
        );
        if (!sourceAbsolutePath) {
          continue;
        }
        try {
          // `git rm --cached` also appears as a staged deletion, but the
          // source still exists. lstat detects broken symlinks as well.
          fs.lstatSync(sourceAbsolutePath);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            continue;
          }
        }
        return sourceAbsolutePath;
      }
    }

    // Unstaged moves: get the actual deleted-path set first. Combining
    // --stage with --deleted does not filter the index, so intersect the
    // stage records with this set explicitly.
    const deletedPaths = git(workspaceFolder, [
      'ls-files',
      '--deleted',
      '--full-name',
      '-z',
    ]).split('\0').filter(Boolean);
    if (deletedPaths.length === 0) {
      return null;
    }
    // Git cannot correlate an untracked destination by itself. Require the
    // same basename as corroborating evidence so an unrelated deleted file
    // with identical bytes cannot suppress genuine agent output.
    const destinationBasename = path.posix.basename(relativePath);
    const candidates = deletedPaths.filter(
      (deletedPath) => path.posix.basename(deletedPath) === destinationBasename,
    );
    const candidateSet = new Set(candidates);

    // Bound argv size for large deletion sets (Windows has a much lower
    // command-line limit than POSIX). In normal moves the basename filter
    // leaves only one or two candidates.
    const BATCH_SIZE = 100;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const deletedEntries = git(workspaceFolder, [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '--full-name',
        '-z',
        '--',
        ...batch,
      ], repoRoot).split('\0').filter(Boolean);

      for (const entry of deletedEntries) {
        const separator = entry.indexOf('\t');
        if (separator < 0) {
          continue;
        }
        const header = entry.slice(0, separator);
        const deletedPath = entry.slice(separator + 1);
        if (!candidateSet.has(deletedPath)) {
          continue;
        }
        const blobHash = /^\d+ ([0-9a-f]+) \d+$/.exec(header)?.[1];
        if (blobHash === destinationHash) {
          return resolveWorkspaceSource(workspaceFolder, workspaceRepoPath, deletedPath);
        }
      }
    }
  } catch {
    // Not a Git repo, git unavailable, or an unreadable path: fail open and
    // retain the existing agent-detection behaviour.
  }

  return null;
}
