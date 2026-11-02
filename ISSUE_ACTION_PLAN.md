# CodeVibe Issue Action Plan (Prioritized)

Date: 2026-11-02  
Repo: waka-man/codevibe  
Branch: main (v0.1.16 shipped)

## Current state
- Open issues: 5 (#8, #11, #16, #29 — all features/minor bugs)
- Releases: v0.1.11 through v0.1.16 all shipped, v0.1.16 is Latest
- Full test suite: 68 suites / 1869 passed / 18 skipped

## Completed (closed issues)

| Issue | Fix | Release |
|-------|-----|---------|
| #14 | Idempotent dashboard view registration (try/catch guard) | v0.1.14 |
| #26 | Closed as duplicate of #14 | — |
| #31 | Closed as duplicate of #14 | — |
| #25 | Custom thresholds applied to ThresholdManager at activation + level change | v0.1.15 |
| #27 | Dashboard webview `\n` escape fix | v0.1.13 |
| #17 | Closed as duplicate of #7 | — |
| #22 | Closed as duplicate of #6 | — |
| #9 | Git operation detection skips external-file-change during active pulls | v0.1.14 |
| #24 | Same fix as #9 (git pull false AI attribution) | v0.1.14 |
| #10 | Already closed (same family as #9/#24) | — |
| #12 | Cross-file cut-and-paste refactoring classified as Neutral (not AI) | v0.1.16 |

## Remaining open issues

| # | Title | Type | Severity | Fixability | Root area | Action |
|---|-------|------|----------|------------|-----------|--------|
| #11 | Prettier auto-formatting detected as AI activity | Bug | Medium-High | Medium | `src/detection/ChangeAttributionClassifier.ts`, `src/trackers/UnifiedAITracker.ts` | Detect formatter-created changes (bulk whitespace/format-only edits) as Neutral. Check if deletion+paste pattern from `documentSave` events. Add regression tests. |
| #8 | Flags VSCode Default Files as Agentic AI | Bug | Medium-High | High | `src/trackers/UnifiedAITracker.ts`, exclusions config | Expand default excluded paths to include `.vscode/`, `codepause-baselines.json`, VS Code generated settings. Check `ExcludedPaths.ts`. Add regression tests. |
| #16 | Feature: Add Support for the Zed Code Editor | Feature | Medium | Low | Platform abstraction | Major integration work; defer. |
| #29 | Feature: AI tracking | Feature | Medium | Low | UI/visualization | Larger feature; needs design discussion. Deprioritize unless user explicitly wants. |

## Action plan by subagent

### Subagent 1: Formatting attribution (P1)
**Goal:** Fix #11 — Prettier auto-format not flagged as AI
1. Examine `UnifiedAITracker.handleTextChange` for save-time events (VS Code `onDidSaveTextDocument`).
2. Add heuristic: format-only changes (bulk whitespace changes, re-indentation) classified as Neutral.
3. Consider tracking `documentWillSave`/`didSave` events to mark formatting.
4. Add regression tests mirroring Prettier format-on-save.
5. Close #11 when verified.

### Subagent 2: Default exclusions (P1)
**Goal:** Fix #8 — VS Code default files flagged as Agentic AI
1. Review `ExcludedPaths.ts` for default excluded globs.
2. Add `.vscode/`, `codepause-baselines.json`, VS Code settings to defaults.
3. Verify existing tests still pass.
4. Close #8 when verified.

### Subagent 3: Features (P2)
**Goal:** Evaluate #16, #29
- These are feature requests, not bugs. File design issues or defer.

## Verification
- Run `npm test` / relevant test suites after changes.
- `npm run compile` / tsc check.
- Manual smoke: load extension, dashboard opens, no activation errors.

## Notes
- Keep public issue comments concise (no internal deliberation). 
- Follow repo patterns (use existing utilities like CommandRegistration). 
- CI disabled in repo; rely on local tests.
- Never weaken integrity-enforcement semantics without explicit approval.
