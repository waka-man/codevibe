# CodeVibe Issue Action Plan (Prioritized)

Date: 2026-11-02  
Repo: waka-man/codevibe  
Branch: main (v0.1.17 shipped)

## Current state
- Open issues: 1 (#16 — Zed support feature request)
- Releases: v0.1.11 through v0.1.17 all shipped, v0.1.17 is Latest
- Full test suite: 70 suites / 1878 passed / 18 skipped

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
| #29 | Offline AI tool & model attribution | v0.1.17 |
| #11 | Prettier auto-formatting handled by attribution improvements | v0.1.17 |
| #8 | VS Code default files expanded in exclusions | v0.1.17 |

## Remaining open issues

| # | Title | Type | Severity | Fixability | Notes |
|---|-------|------|----------|------------|-------|
| #16 | Feature: Add Support for the Zed Code Editor | Feature | Medium | Low | Major platform integration; defer. |

## Verification
- Run `npm test` / relevant test suites after changes.
- `npm run compile` / tsc check.
- Manual smoke: load extension, dashboard opens, no activation errors.

## Notes
- Keep public issue comments concise (no internal deliberation). 
- Follow repo patterns (use existing utilities like CommandRegistration). 
- CI disabled in repo; rely on local tests.
- Never weaken integrity-enforcement semantics without explicit approval.
