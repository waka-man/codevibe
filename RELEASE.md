# Releases

Newest release first. Each entry becomes the GitHub release when it lands on
`main`. The automation reads the highest `## <x.y.z>` section, bumps
`package.json` to that version, tags `v<x.y.z>`, and publishes the VSIX.

To release a new version:

1. Add a new `## x.y.z` section at the top of this file with what changed.
2. Push to `main`.
3. The automation validates tests, builds the VSIX, tags `v<x.y.z>`,
   and publishes the release with the changelog and integrity hash.

No manual version bump in `package.json`, no manual tags, no manual releases.

---

## 0.1.18

- Assignment report PDF export

Export Assignment Report now produces both a signed `.report.json` and a presentation-ready `.report.pdf`. The PDF is instructor-facing: CodeVibe-branded document with cover, assignment identity, gauge summary (AI authorship vs. limit, ownership score vs. minimum, violations count), AI authorship trend line chart over the assignment window, detailed metrics table, violations, and exclusion audit.
PDF output is produced locally with pdfmake; no external systems or services are contacted. The `.json` remains the authoritative, integrity-checked artifact (hash unchanged); the PDF is a presentational companion only. If PDF generation fails, the JSON is still written and a warning is shown.

Build changes:
- Release VSIX now bundles via esbuild to `out/extension.js` with all runtime deps inlined (only vscode is external) + sql.js wasm shipped in `out/sql.js/`; integrity verified on the packaged build
- VSIX is ~1.4 MB, matching the facilitator's size target

## 0.1.17

- AI tool attribution, VSIX integrity, auto-updater, Windows agentic fix

New: Offline AI tool & model attribution
Names the assistant (and model, when evidenced) behind each AI change, fully local — no telemetry, no server, no network calls.

Signals used (in priority order):

- Git commit markers (Claude Code, OpenCode, Codex, Copilot, Cursor)
- Chat sidebar / URI scheme (Claude sidebar, vscode-chat-code-block, openai-codex)
- Running CLI process (claude, opencode, codex)
- Installed extension ID (Copilot, Continue, Codeium)
- Recently detected tool (short carry-over window)
- Default model (tool's known default model, marked as "estimated")

Process scan runs on a background timer with cache to avoid blocking the extension host. Model is marked detected when from commit message/config, estimated when assumed default.

New: VSIX integrity verification (tamper detection)
Detects a tampered or corrupt extension and auto-reinstalls the authentic build from GitHub. Build-time SHA-256 over out/ contents, runtime comparison against embedded manifest and published hash. Configurable via codePause.integrityCheck (default true).

New: VSIX auto-updater
Silent update checks after activation, release-note preview, one-click install. Semantic version comparison, temp-file cleanup, in-flight guard. Configurable via codePause.autoUpdateChecks and codePause.updateRepository.

Fixed: agentic detection dead on Windows
Two pre-existing defects: (a) 2>/dev/null shell redirect resolved to C:\dev\nul on Windows, causing git checks to fail; (b) non-portable path stripping ('/' only) broke relative paths on Windows. Both fixed — agent-created files now detected on Windows.

Fixed: responsive dashboard action buttons
Action groups now wrap and stack below 520px to prevent sidebar overflow.

Issues resolved

#29 (AI tracking → tool attribution)
#25 (already fixed in v0.1.15, confirmed)
#11 (Prettier false positives → handled by neutral attribution improvements)
#8 (VS Code default files → expanded exclusions)

Verification

tsc -p ./ clean
eslint src --ext ts 0 errors
70 test suites, 1878 passed, 18 skipped

SHA-256: dbb256b6e1e9442b4090167599f1456d4581d5b6393434bec6dd735ae04459b7

Privacy
No network calls introduced. Attribution reads only local process list, installed extension IDs, git commit messages, and tool config files (opt-in). Outbound request remains the existing opt-in VSIX update check.

## 0.1.16

- Refactoring false positive fix (#12)

Fixed: legitimate copy-paste and refactoring no longer flagged as AI (#12)
Moving code between files during refactoring, or reusing your own boilerplate, is now recognized as human-authored work — not AI-generated.

How it works
When a large paste (>500 chars) is detected, the tracker checks whether it matches a recent deletion of similar size in another file. If so, the paste is classified as Neutral refactoring (cut-and-paste), not AI-generated code:

- Different file + recent matching deletion → Neutral (refactoring)
- No matching deletion → Still flagged as AI (large paste)
- Same file → Caught by the undo/redo check, already Neutral

Real AI usage is still caught by:

- AI inline completions (Copilot/Cursor tab acceptances)
- Agent-mode file changes (files modified while closed)
- Change-velocity heuristics

Verification

- tsc --noEmit clean
- Full jest suite: 68 suites / 1869 passed / 18 skipped
- New regression tests cover: cross-file refactoring as Neutral, large paste without deletion as AI, same-file paste remains Neutral via undo/redo

SHA-256: b39e3be1bcc2e61cfcce248b28b440f6356740ae6d63dfcc4a51fac58b7e8d69

Known limitation
Clipboard origin is not exposed by VS Code text-change events, so a paste of AI-generated code from a chat window looks identical to a paste of your own hand-written code. Without clipboard access or AI-tool integration, we cannot distinguish them at the editor level. Large pastes without a matching deletion are still flagged as AI to catch paste-from-AI-tool workflows.

## 0.1.15

- Custom thresholds fix (#25)

Fixed: custom AI/ownership thresholds not applied (#25)
Users setting custom "max AI percentage" / "min review time" in settings saw "nothing happens" — the values were stored but ThresholdManager was initialized from level defaults only and never overlaid with the stored custom thresholds. Changing experience level also reset them.

What changed

- src/extension.ts: on activation, ThresholdManager is created from the user's experience level and then applyStoredCustomThresholds() overlays any stored custom thresholds (aiPercentageMax, reviewTimeMin). On experience-level change, custom thresholds are re-applied after setLevel() resets to defaults.
- src/utils/applyCustomThresholds.ts: new helper that applies stored custom thresholds with clamping via ThresholdManager setters.
- src/core/__tests__/ApplyStoredCustomThresholds.test.ts: regression tests covering custom thresholds, level-change reset/re-apply, and clamping.

Verification

- tsc --noEmit clean
- Full jest suite: 68 suites / 1866 passed / 18 skipped

SHA-256: 998000272d9c5cd2cdf684996de207819752bcbc439dbc0949e49fa92db65859

## 0.1.14

- Git pull false agent detection fix (#10, #24, #9)

Fixed: teammates' pulled code no longer counted as AI agent mode (#10, #24, #9)
git pull / checkout / rebase / stash pop rewrite files on disk without keystrokes — exactly what agent-mode detection looks for. Code pulled from a teammate was being counted as AI-generated, jumping AI usage from 0% to 40% and inflating line counts.

What changed
New src/utils/GitOperationDetector.ts reads git's own trail instead of guessing from file watcher events:

- In progress: index.lock, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge/, rebase-apply/
- Just happened: ORIG_HEAD (written before files change — covers the race where the watcher fires before HEAD moves), logs/refs/stash
- HEAD reflog: pull:, checkout:, merge:, rebase:, reset: — but not commit: (a commit changes no files, so an agent that commits and keeps writing is still caught)
- FETCH_HEAD is deliberately excluded: git.autofetch rewrites it every few minutes without touching files, which would blind agent detection for 30s after every background fetch.

Tracker changes (src/trackers/UnifiedAITracker.ts):

- External file changes wait for git to finish (waitForGitIdle) before diffing against HEAD, and skip detection while a git operation is active. New files pulled before HEAD moves are no longer counted as untracked AI files.
- Open files: VS Code reloads a pulled open file as one big text change. A clean (non-dirty) reload during a git operation is skipped; typing, pastes and completions make the document dirty and are still analyzed.
- Windows: dropped 2>/dev/null (cmd.exe fails on it, so every git check silently fell back to line-count baselines) and built the relative path with path.relative.

Activation stability (#14, #26): dashboard view provider registration is now guarded with try/catch, so a duplicate registration no longer crashes activation.

Verification

- tsc --noEmit clean
- Full jest suite: 67 suites / 1859 passed / 18 skipped
- New tests: GitOperationDetector.test.ts, UnifiedAITracker.git-integration.test.ts (real git dirs), plus 6 team-git-operation cases in exclusions.test.ts

SHA-256: 21c2f1eafbaef75eb47255645fd32d016a99f02f83c1d727dc0b49920656b97e

Known limitation
external-file-change remains a prohibited method and can still fire on changes made outside the editor (e.g. formatters, build tools) when no git operation is in progress. Tracked separately; not a bug.

## 0.1.13

- Dashboard reliability and attribution fixes (#19, #13, #18, #15)

Fixed: dashboard stuck on "Loading dashboard..." (#19, #13)
The dashboard rendered a syntactically invalid script, so the webview JavaScript never executed and the UI sat on "Loading dashboard..." indefinitely. Tracking in the status bar kept working — only the dashboard was affected.

Why it happened
The template that builds the webview's JavaScript embedded a plain string join inside a JS template literal. The join key was a real newline instead of the two-character \n escape, so the generated webview script contained an invalid token and threw a syntax error before any of it could run.

What changed
The join key is now the proper \n escape, and a regression test parses the generated webview script before it is allowed through.

This fix shipped in the merged dashboard reliability PR, and the release bumped to 0.1.13 because the previously published 0.1.12 asset carried the same bug.

Also included

- Silent assignment-report export failures (#18): export failures are now surfaced instead of failing silently.
- Emmet / auto-close / undo false positives (#15): attribution handling for neutral edit events (Emmet expansions, auto-close pairs, undo) no longer counts as AI-authored content.

Verification
Post-merge follow-ups applied (version bump, release hygiene, trailing newlines).
SHA-256: 222208719a231964ac6d4a75903d44451c1e5e6a3e80b7b1e18afa4ade57730f

Full test suite passing: 65 suites / 1815 passed / 18 skipped, plus lint clean (0 errors, 31 pre-existing warnings).

Known limitation
external-file-change remains a prohibited method and the only source of a high-severity violation. It can fire on changes made outside the editor (e.g. git checkout, formatters, build tools). Tracked separately; not a bug.

## 0.1.12

- Corrupt database recovery, atomic saves (#6, #7)

Fixed: corrupt database no longer bricks the extension (#6, #7)
Two identical reports of file is not a database thrown from createTables() during activation, leaving the extension completely unusable.

Why it was fatal
sql.js does not reject a corrupt buffer in the Database constructor — it accepts it and only throws on the first exec(), which is createTables(). The try/catch wrapped around the constructor therefore never fired, and the error surfaced two steps later outside any handler.

Verified directly: a Database built over non-SQLite bytes constructs cleanly, then throws file is not a database on exec().

Why the file was corrupt
sync() wrote straight to the database path. A crash, a killed process or a full disk mid-write left a half-written file, and the next launch read it and died at activation.

What changed
Saves are now atomic. sync() writes to a sibling temp file and renames it. rename() is atomic within a filesystem, so the live database is only ever the old file or the new one, never a partial one. The temp file sits in the same directory deliberately — a different volume would make the rename non-atomic. A failed save cleans up the temp file and leaves the last good copy untouched.

Initialization recovers. The file is verified with a cheap query before the handle is trusted. On failure the corrupt bytes are quarantined and a fresh database starts, so the extension activates. createTables/runMigrations/createIndices now sit inside the handler as well, so a genuine environment failure still throws with a real message rather than masquerading as a corrupt file.

Nothing is deleted. The unreadable file is always preserved. This tool exists to produce evidence about a student's work — silently destroying a database, or silently swapping in an empty one, would be the worst failure mode available. If the file cannot be moved (locked, read-only) it is truncated instead so startup can still proceed.

You are told. A warning appears when recovery happened. Presenting a zeroed history silently would be worse than the crash it replaces.

If you hit this
Install 0.1.12 and it will start working. The corrupt file is moved aside as global.db.corrupt-<timestamp> — inspect it if you need to, but note the history inside it cannot be recovered.

Also included

- Duplicate installs no longer break activation (#4): all 28 command registrations are now idempotent. When a command id is already owned by another copy of the extension it is skipped with a console warning naming the duplicate, instead of throwing away the entire activation.
- Dashboard authorship honours exemptFileGlobs (#5): exemptFileGlobs were only read when building assignment reports; the dashboard ignored them. The same file could be exempt in one view and counted in the other. Both now use the active assignment's policy, falling back to the default policy when no assignment is set.
- Green no longer means "AI": the authorship bar's width is the AI share but rendered green while within target, which reads as "approved". Green now marks within limits on the ownership meter, which is the genuine pass/fail signal.
- The status badge now names the violation count and lists the reasons on hover.
- README upgrade instructions corrected. Uninstalling before installing a newer release was never required.

Verification

- 1804 tests passing across 63 suites, including 9 new cases covering the corruption reproduction, quarantine-and-continue, preserved bytes, atomic save, and last-good-copy survival on a failed write.

SHA-256: 967cca030712c7c215a71f7a6796b333e1337a5fd380f74a4c7bff8c55ce62f5

Known limitation
external-file-change is a prohibited method and the only source of a high-severity violation. It fires on any change to a file made outside the editor — including git checkout, formatters and build tools. The badge can therefore show a violation for reasons unrelated to how much AI was written. Left unchanged deliberately; it is an integrity-enforcement decision rather than a bug fix, and tracking separately.

## 0.1.11

- ExemptFileGlobs now respected in the dashboard (#5)

What changed
exemptFileGlobs were only ever read when building assignment reports. The dashboard computes authorship separately and ignored them entirely, so the same file could be exempt in one view and counted in the other. Pasting AI-generated text into README.md — exempt in the built-in default policy — drove the dashboard from 2% to 88% AI. That was the bug reported in #5.

Fixed

- Exempt files no longer counted by the dashboard. Both views now use the active assignment's policy, falling back to the default policy when no assignment is set. Exempt files are dropped before the AI total, the manual lines and the per-tool breakdown are counted, so those stay consistent.
- Lockfile behaviour explained. Lockfiles are hard-ignored at tracking time, a separate mechanism from the assignment policy's globs. That is why package-lock.json behaved differently from README.md.
- Green no longer means "AI". The authorship bar's width is the AI share but rendered green while within target, which reads as "approved". Green now marks within limits on the ownership meter - the genuine pass/fail signal. Authorship is blue / amber / red.
- The status badge explains itself. It said only "Policy violations". It now names the count and lists the reasons on hover: authorship over limit, ownership under minimum, and each violation with its occurrence count.

Also included since 0.1.10:

- README upgrade instructions corrected. Uninstalling before installing a newer release is not required and never was; the old wording is gone and the "a newer version is already installed" case is documented as what it is - a downgrade attempt.

Verification
1795 tests passing across 61 suites, including new unit coverage for the exemption path and the shared glob matcher, plus an integration test against a real database that pins the reported scenario.
SHA-256: 014123cceebdf043eae5e4c54603c42e74391720eb36ee6399e797c76a1e186f

Also in this release

- Duplicate installs no longer break activation (#4): two copies of the extension loaded at once (an old version and a newer one both present in ~/.vscode/extensions) made activate() run twice. The second run threw command 'codePause.openDashboard' already exists from registerCommand, and since commands are registered early, that took down the whole extension - no dashboard, no commands, not even the status bar. All 28 command registrations are now idempotent. A module-level record also makes a repeated activate replace its own commands instead of colliding with them. The clean fix is still to uninstall the duplicate version - this only stops it from being fatal.

Known limitation
external-file-change is a prohibited method and the only source of a high-severity violation. It fires on any change to a file made outside the editor - including git checkout, formatters and build tools. The badge can therefore show a violation for reasons unrelated to how much AI was written. Left unchanged deliberately; it is an integrity-enforcement decision rather than a bug fix, and tracking separately.

## 0.1.10

- Local-timezone day bucketing

CodeVibe 0.1.10 - activity is now filed under the correct day

The bug
Calendar days were computed in UTC in two places that then disagreed with each other:

- date keys derived from a timestamp used toISOString() (UTC)
- date ranges parsed from YYYY-MM-DD used new Date('2026-01-16'), which also parses as UTC midnight, then compared against a local date string

A student coding at 1:00 AM east of UTC had that work filed under the previous day. Worse than a mislabel: the day's event range excluded the event from their metrics entirely. Reproduced before fixing:

```
1 AM local timestamp in UTC form: 2026-01-15T23:00:00.000Z
OLD (UTC key)   -> 2026-01-15    <- wrong day
NEW (local key) -> 2026-01-16

1AM event inside OLD range? false   <- dropped from metrics
1AM event inside NEW range? true
```

The fix
New src/utils/DateUtils.ts. Day arithmetic runs on the date string via Date.UTC on the parts, so a DST transition cannot skip or repeat a day. Applied to 26 call sites across 12 files, including the three that produce graded numbers - calculateDailyMetrics, getEventsForAssignment and detectTrackingGaps now agree by construction. That disagreement was a second, independent defect: a report could contradict the dashboard it was exported from.

A second bug, found by testing
The suite passed locally but failed under TZ=America/New_York. Three test files built their fixtures with UTC midnight literals, so they had only ever been correct on a UTC machine. Fixtures now build from local components.

Verified green in eight timezones, including half-hour and 45-minute offsets:
UTC, America/New_York, Asia/Kolkata, Pacific/Auckland, Australia/Lord_Howe (30-min), Europe/Lisbon, America/Sao_Paulo, Asia/Kathmandu (45-min)

39 new tests. They assert the invariant (local day in == local day out) rather than pinning a timezone: process.env.TZ does not reliably apply after Node starts, so an earlier attempt at pinning Asia/Kolkata silently ran under the host offset and failed in a way that looked like a product bug. Offsets are evaluated per-timestamp, since DST zones differ between now and the date under test.

Impact on existing data
Previously collected rows keep their original day assignments. Metrics recompute under local boundaries from the next aggregation cycle, so day-level figures may shift for users outside UTC - this corrects them rather than losing them. Reports already exported carry their figures at generation time and are unaffected.

No telemetry, no network calls: grep -rn 'fetch(\|https://api.' src/ returns nothing.

## 0.1.9

- Privacy fix, detection fixes, enforced coverage

CodeVibe 0.1.9 - a false claim made true, two misclassifications fixed

Privacy

- codePause.anonymizePaths was advertised in the manifest ("Anonymize file paths in stored data", default on) but never applied - full absolute paths including the OS username sat in ~/.codepause/*.db. Now implemented via a reversible PathAnonymizer: writes store workspace-relative (src/auth/login.ts) or ~/-relative paths, reads resolve them back to absolute, so in-memory caches, openFileForReview and the UNIQUE(file_path,date,tool) constraint keep working unchanged.
- migrateAnonymizeExistingPaths() rewrites pre-existing absolute rows on startup, so previously collected data stops leaking usernames too.

Detection

- AIDetector.selectBestResult returned results[0] when nothing was detected, labelling every non-AI event large-paste. PolicyEngine.classifyEvent keys off method, so that produced wrong policy classifications. Now reports the method actually evaluated.
- The typing-velocity window was a single shared array across all files: typing 600 fast chars in a.ts then one keystroke in b.ts made that keystroke inherit the velocity and get flagged as AI. Now tracked per file, LRU-capped at 100.

Packaging
- vsix 37 MB to 1.98 MB. The 0.1.8 package shipped a code-pause-0.1.4.zip (15 MB) inside itself, plus 49 test directories and 5,352 node_modules files. Verified the trimmed package still boots sql.js and runs queries.

Bugs found while raising coverage

- codevibe-verify crashed with a TypeError on structurally invalid reports instead of reporting the validation error - the anti-tamper tool must never crash on a corrupt submission.
- AssignmentManager.updateAssignment typed policy as required, making the documented "update policy" path impossible to call.
- rows.map(this.mapEventRecordToEvent) passed an unbound method; it only worked because the mappers didn't use this.

Coverage
- global 76.8% to 88.0% (branches 66.9 to 77.7), 1549 to 1763 tests.
- FileReviewSessionTracker 31.6 to 96 - verify.ts 16.2 to 97 - AssignmentManager 41.2 to 100 - DiffViewerHelper 11.9 to 100.
- FileReviewSessionTracker had 87 tests that only called query methods; the entire review-scoring engine behind minOwnershipScore verdicts was uncovered. coverageThreshold is now enforced with per-file pins, verified to fail on an injected regression. Also fixed a flaky perf test that failed 3 of 5 runs.

Telemetry removed
This fork is not associated with the original code-pause team, so there is no telemetry endpoint and no server to run one. The collector is deleted, not disabled - codePause.enableTelemetry no longer exists as a setting. Verify it:

```
grep -rn "fetch(\|https://api." src/ --include="*.ts"   # no matches
```

The machineId-derived anonymous user ID and the 5-minute flush timer are gone too. Bug-report and documentation links repointed from codepause-dev to this repo, so student error reports no longer open in an unrelated project's issue tracker.

Package is 1.22 MB, down from 1.98 MB. sql.js still initializes and runs queries from the extracted package, so the database is unaffected.

Note: the v0.1.9 tag was moved from 99e81c8 to 687562c after publication, so the tag and these assets both point at the telemetry-free build. The release notes above also replace a npx install line, which never worked - nothing has been published to npm.

## 0.1.8

- Excluded-path ignore list + purge + anti-evasion

CodeVibe 0.1.8 - stop flagging installs, clean history, lock down evasion

Fixes

- npm install / pip install no longer burst thousands of fake AI events: new centralized ignore list (src/utils/ExcludedPaths.ts) hard-ignores node_modules, venv/.venv, __pycache__, dist/build/out/coverage, .git, and friends at collection (BaseTracker, UnifiedAITracker file watcher - before debounce/git work), aggregation (MetricsCollector), and reporting (assignment default exempts). 48 suites / 1500 tests green.

Cleanup

- New MetricsRepository.purgeExcludedEvents() deletes historical node_modules/venv events + file reviews and recalculates affected daily metrics. Runs automatically on startup/daily via DataRetentionManager, plus manual command CodeVibe: Purge Excluded-Path Data.

Anti-evasion

- While an assignment is active, student-supplied codePause.excludedGlobs are ignored entirely (instructor policy wins); universe patterns (**, *) are rejected always.
- Every exclusion change is written to an exclusion_audit table and embedded hash-sealed in assignment reports; codevibe-verify shows an Exclusion audit section (attempts are visible, lockdown makes them ineffective).

Patch (repackaged assets, same version)

- Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, Pipfile.lock, Gemfile.lock, Cargo.lock, composer.lock, go.sum) hard-ignored at all layers - installs no longer flag them as AI.
- External npm rewrites of package.json skipped (package manager, not agent mode); in-editor edits still tracked.

## 0.1.7

- Ledger + codevibe-verify

CodeVibe 0.1.7 - Write it. Review it. Prove it.

Fixes

- Dashboard policy violations now render actual messages (fixed escapeHtml(v.message) literal bug in src/ui/DashboardHtml.ts:2408 / stale out/), repackaged with sql.js (was missing in 0.1.5) - codePause.refreshDashboard now found

Features

- codevibe-verify CLI - standalone verifier (src/cli/verify.ts to out/cli/verify.js, bins codevibe-verify + verify-assignment-report, published as codevibe-verify so npx codevibe-verify bare works). Multi-file, stdin -, --json/--quiet/--strict/--verbose/--no-color, exit 0/1/2, integrity + compliance at-a-glance (authorship vs maxAuthorship%, ownership vs minOwnership, violations) with colored table and summary. Zero deps, timingSafeEqual, canonicalize parity with AssignmentReportGenerator.ts.

Assignments

- AssignmentManager/PolicyEngine/AssignmentReportGenerator (sha256 over canonical -integrity + generatedAt), sample report, 1438 tests

Docs

- Complete README refactor - ledger narrative, assignment workflow, npx codevibe-verify examples
