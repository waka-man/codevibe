# Automated Release via RELEASE.md

## Goal

Automate GitHub releases so the facilitator never has to build locally, hash the
VSIX by hand, or create a release manually. One source of truth for version +
changelog: `RELEASE.md`.

## Trigger

`push` to `main` (any push). The job no-ops cleanly when
`max(RELEASE.md versions) <= latest git tag`, so ordinary pushes are ignored.
A `RELEASE.md`-only path filter may be added later without changing behavior.

## RELEASE.md format

Single file, newest release first:

```markdown
# Releases

## 0.1.15
- Fixed agent-flagged pulled code
- ...

## 0.1.14
- Fixed dashboard webview startup
- ...
```

The release version is the numerically greatest semver heading `## <version>`.

## Workflow behavior (`.github/workflows/release.yml`)

Single job, least privilege + `contents: write`:

1. Checkout (full history + tags). Setup Node 20, `npm ci`.
2. Extract max version from `RELEASE.md` (`## ` regex, parse semver).
   Extract changelog body for that version.
3. Latest tag: `git tag --sort=-v:refname | head -n1`. If
   `releaseMdVersion <= latestTag` → log "already released" and exit 0.
4. `npm pkg set version=<x.y.z>` (package.json becomes source-consistent).
5. `npm run compile` (runs `tsc` + `compute-integrity`).
6. `npm test` — release gate; any failure aborts the release.
7. `npx @vscode/vsce package --no-dependencies` producing
   `codevibe-verify-<version>.vsix`.
8. SHA-256 of the VSIX; notes = changelog + `Integrity: <hex>`.
9. Commit `chore: release <version>` to `main`, tag `v<version>`, push both.
10. `gh release create v<version>` with the VSIX attached and body = notes.

Concurrency group `release` prevents concurrent runs. A self-bump re-triggers
the workflow, but it sees version == tag and no-ops (no release loop).

## Release output

- Asset: `codevibe-verify-<version>.vsix`
- Title: `v<version>`
- Body: changelog section verbatim + a trailing `Integrity: <sha256-hex>` line
  (consumed by the extension's integrity verification).
- Marked as the latest release automatically by GitHub.

## Non-goals

- No Marketplace publish. No manual version input. Keeps existing CI disabled.
- Does not change the extension's runtime; purely build/release tooling.

## Risks / notes

- Workflow pushes a commit back to `main` — `main` must allow bot pushes (or a
  PAT). The self-commit re-trigger resolves to a clean no-op.
- `npm test` becomes a hard release gate (previously not a gate).
- CI passes `if: false` in existing `ci.yml` are intentionally left untouched.

## Verification

- Dry run locally: `node scripts/compute-integrity.js` produces a hash that
  matches a recomputation of `out/` (build now does this as part of `compile`).
- After merge: add `## 0.1.15` to `RELEASE.md`, push to `main`; expect tag
  `v0.1.15`, release with attached VSIX, and `Integrity:` line in the body.
