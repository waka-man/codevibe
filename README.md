<div align="center">
  <img src="resources/codepause-icon.png" width="76" alt="CodeVibe">
  <h1 style="margin-bottom:0">CodeVibe</h1>
  <p><strong>Write it. Review it. Prove it.</strong><br>
  <span style="opacity:.72">A VS Code extension that tracks AI-assisted coding, plus a standalone verifier that proves a report wasn't edited.</span></p>

  <p>
    <img src="https://img.shields.io/badge/version-0.1.10-0a0a0a?style=flat-square&labelColor=0a0a0a&color=00d084" alt="Version 0.1.10">
    <img src="https://img.shields.io/badge/VS_Code-1.85%2B-007ACC?style=flat-square&logo=visual-studio-code" alt="VS Code 1.85+">
    <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js" alt="Node 20+">
    <img src="https://img.shields.io/badge/tests-1730%20passing-0a0a0a?style=flat-square&labelColor=0a0a0a&color=3fb950" alt="1730 tests passing">
    <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-Business%20Source%201.1-EEEEEE?style=flat-square&labelColor=0a0a0a&color=EEEEEE" alt="License"></a>
  </p>
</div>

```
$ code .
$ # ... work as usual with Copilot / Cursor / Claude Code ...

$ node codevibe-verify.js hw3.report.json

✔ hw3.report.json — INTEGRITY OK — COMPLIANCE PASS
  Assignment: HW3 - Binary Search Trees (asgn-hw3-2026) | Student: student-042
  Authorship: 18.4% AI (limit 30%)  ✓ PASS — 52 permitted + 0 prohibited + 12 flagged
  Ownership:  92.0 /100 (min 40)    ✓ PASS — 4 reviewed, 0 unreviewed
  Violations: 0 — none

Summary: 1 file — 1 integrity OK, 0 FAIL — 1 compliant, 0 non-compliant
Result: All reports authentic and compliant.
```

One hash. If it matches, the numbers weren't changed after export.

---

## Why this exists

Writing code with AI is normal. Writing code you can't explain is the problem.

Most AI trackers answer "how much of this is AI?" CodeVibe answers the harder question — **did you actually read it?** — and then gives you a signed artifact so the answer survives outside your laptop.

| It measures | Where it appears | How it's judged |
|---|---|---|
| **Authorship** — AI lines ÷ total lines | Dashboard meter, `report.metrics.authorship` | Must stay under `maxAuthorshipPercentage` |
| **Ownership** — 0–100 from real review signals | Dashboard meter, `report.metrics.ownership` | Must stay above `minOwnershipScore` |
| **Violations** — agentic use, exceeded authorship, unreviewed pastes, tracking gaps | Dashboard panel, `report.metrics.violations[]` | Zero for a clean report |
| **Integrity** — `sha256` over the canonical report | `report.integrity.hash` | Recomputed and compared by `codevibe-verify` |

`generatedAt` is deliberately **not** signed, so re-exporting unchanged data produces an identical hash. Editing any metric after export breaks it.

### What this is not

Not a linter. Not a grader. Not a liveness detector.

It cannot tell you whether a student disabled the extension, edited the database, or pasted in a report someone else produced. It **detects tampering after the fact** and makes gaps visible. Any tool a student controls is ultimately trust-based — the honest position is that this raises the cost of cheating, it does not abolish it.

---

## For Students

**Time required: about two minutes of setup.**

### 1. Install the extension

CodeVibe isn't on the Marketplace or npm yet. Grab the `.vsix` from the [latest release](https://github.com/waka-man/codevibe/releases/latest):

```bash
# Download codevibe-extension-<version>.vsix from the releases page, then:
code --install-extension codevibe-extension-0.1.10.vsix
```

Or in VS Code: `Cmd/Ctrl+Shift+X` → gear menu → **Install from VSIX…**

### Upgrading from a previous version

Because CodeVibe is sideloaded (not from the Marketplace), VS Code won't replace the old version automatically. You need to uninstall the previous one first, then install the new release.

**Terminal:**

```bash
# Find the installed extension ID
code --list-extensions | grep -i codevibe

# Uninstall it (replace with whatever the above command returns)
code --uninstall-extension codepause.codevibe-verify

# Install the new version
code --install-extension codevibe-extension-<version>.vsix
```

**Or in VS Code:** `Cmd/Ctrl+Shift+X` → find CodeVibe → click the gear icon → **Uninstall** → then install the new `.vsix` using **Install from VSIX…**

After either method, reload VS Code (`Cmd/Ctrl+Shift+P` → "Reload Window").

### 2. Tell it your experience level

On first launch, CodeVibe asks whether you're a junior, mid, or senior developer. This sets your daily AI-usage target and how strict the review coaching is. You can change it any time with `CodeVibe: Change Experience Level`.

### 3. If your course uses assignments, create one

Ask your instructor for the assignment name, dates, and policy limits, then:

`Cmd/Ctrl+Shift+P` → **CodeVibe: Create Assignment**

Students don't set the policy — instructors give you the limits. The command is here so the report is correctly scoped to your course.

### 4. Work normally

Nothing to configure. Use your AI tools as usual.

When an AI agent writes code for you, open the file and **actually read it** — scroll through it, move through it, edit it. That interaction is the entire ownership signal. Opening a file and leaving it idle counts for nothing, by design.

If you have files to review, the dashboard's `Ownership` card lists them. Scores land in bands: **70+** thorough, **40–69** light, below that unreviewed.

### 5. Export before you submit

**CodeVibe: Export Assignment Report** → pick a location. Optionally enter your student ID so the report is attributable.

Do this as your **last step** before submitting. Any code change after export makes the report stale, and re-exporting is how you fix that (the hash is stable across re-exports of the same data, so there's no penalty for exporting twice).

### 6. Put the report where your instructor asked

The export is a single `*.report.json` file. Submit it alongside your work.

### What gets stored, and where

Everything lives in `~/.codepause/`, one SQLite database per project. No code content, ever — only line counts, timestamps, scores, and file paths. Deleting the folder deletes the record; `CodeVibe: Clear All Data` does it for you.

File paths are anonymized by default (`codePause.anonymizePaths`): stored as `src/auth/login.ts` rather than `/Users/yourname/...`. Existing data is migrated on first launch after upgrading.

### Student FAQ

**Does using AI hurt my grade automatically?**
No. CodeVibe reports numbers; it doesn't decide outcomes. A report showing 25% AI under a 30% limit *passes* — show it to your instructor.

**Can I turn off the nagging notifications?**
Yes: `CodeVibe: Snooze Alerts for Today`, or set `codePause.alertFrequency` to `low`.

**I'm not using this for a class. Can I still use the dashboard?**
Yes. Skip the assignment steps entirely. You get authorship, ownership, and skill-health tracking with no assignment layer, no reports, nothing to submit.

**Why is `node_modules` not being counted?**
Because you didn't write it. CodeVibe hard-ignores `node_modules`, Python environments, and build output, plus every lockfile. A single `npm install` used to register tens of thousands of "AI lines" and wreck your stats; that's fixed.

**Can I exclude a folder I generate code into?**
Yes: `codePause.excludedGlobs`. Add one glob per entry, e.g. `**/generated/**`. Note that these are **ignored entirely while an assignment is active** — see below.

---

## For Educators

**Time required: about five minutes per student, or zero if you only verify.**

### 1. Get the verifier

The verifier is a single dependency-free Node file. Fetch it from the [latest release](https://github.com/waka-man/codevibe/releases/latest) as `codevibe-verify.js`:

```bash
node codevibe-verify.js hw3.report.json
```

No install, no network, no VS Code. It reads a report and prints two independent verdicts.

### 2. Verify what you receive

```
✔ hw3.report.json — INTEGRITY OK — COMPLIANCE PASS
  Authorship: 18.4% AI (limit 30%)  ✓ PASS
  Ownership:  92.0 /100 (min 40)    ✓ PASS
  Violations: 0 — none

✘ hw2.report.json — INTEGRITY FAIL
  Stored:    a57f46b…
  Recomputed: ff5f44f…
  Reason: hash mismatch - the report has been modified after export
```

**Exit codes** — designed for CI and grade sheets:

| Code | Meaning |
|---|---|
| `0` | All reports authentic (and compliant, with `--strict`) |
| `1` | Tampered report, malformed report, or non-compliance under `--strict` |
| `2` | Usage or I/O error — wrong arguments, unreadable file |

### 3. Options that matter for grading

```bash
node codevibe-verify.js reports/*.json --strict    # fail the run on non-compliance too
node codevibe-verify.js reports/*.json --json      # machine-readable
node codevibe-verify.js reports/*.json --verbose   # print each violation's message
cat hw3.json | node codevibe-verify.js -           # stdin
```

By default, exit `1` means only *integrity* failed. A report can be perfectly authentic and still non-compliant, so add `--strict` if you want compliance to gate your pipeline.

### 4. What you tell students

Send them the **For Students** section above, plus these three things:

1. **The policy numbers.** `maxAuthorshipPercentage` (e.g. 30) and `minOwnershipScore` (e.g. 40) must come from you. Students cannot set their own limits.
2. **Where to submit** the `*.report.json`.
3. **The grading rule**, stated in advance. Which of authorship, ownership, and violations actually affect the grade.

### 5. What a student can't game

Three mechanisms, in order of strength:

**The integrity hash** covers every metric. Editing authorship after export breaks it, and the verifier says so.

**Custom exclusions lock during assignments.** If a student adds `**/src/**` to `codePause.excludedGlobs` mid-assignment, the extension ignores it. The built-in ignore list and your policy's exemptions still apply.

**Every exclusion change is logged.** The report embeds an `exclusionAudit` array — every settings change plus activation markers — sealed by the same hash. A student can't remove it without breaking the report.

```
Exclusion audit: 3 entries (1 student settings change, ignored by lockdown)
```

An attempt is *visible*. It isn't *prevented* — see "What this is not" above.

### Educator FAQ

**Can a student just delete the database?**
Yes, and the absence of data is itself the signal: a student with no report where everyone else has one is the outlier. `tracking-gap` violations also flag long untracked stretches inside an active assignment window.

**Do I need to trust the extension that produced the report?**
No. The verifier re-implements the canonicalization and hashing independently of the extension. The two implementations are tested against each other, and you can read both.

**What are the detection signals?**
Inline completions, large pastes (>500 chars, code-shaped), files modified while closed (agent mode), AI attribution in git commits, and typing velocity. Details in [How detection works](#how-detection-works).

**What about students working in a weird directory structure?**
`excludedGlobs` handles it, except while an assignment is active. If a legitimate folder is being ignored, they can raise it with you — the audit trail shows exactly when and what.

**Is the data private?**
Local SQLite in `~/.codepause/`. No code content stored. Paths anonymized by default. **No network calls of any kind** — the telemetry code was removed, not disabled. See [Privacy](#privacy), which is the short version: there is no server, and `grep -rn "fetch(" src/` proves it.

---

## How detection works

Five signals. Highest confidence wins, per event.

| # | Signal | Confidence | What it sees |
|---|---|---|---|
| 1 | Inline completion | `high` | Instantaneous multi-statement insertion, 25–300 chars |
| 2 | Large paste | `high` | >500 chars containing real code structure |
| 3 | External file change | `high` | File modified while closed — agent/composer mode |
| 4 | Git commit marker | `high` | `Co-Authored-By: Claude`, `@claude-code`, `Generated with` |
| 5 | Change velocity | `medium` | >500 chars/sec, **tracked per file** |

A note on #5: typing fast in one file used to inflate the measured velocity of the next file you touched, flagging innocent keystrokes as AI. Velocity is now tracked independently per file.

Review scoring is deliberately conservative about what counts as reading. Time only accrues once you interact — scroll at least once, move the cursor at least five times, or make a small edit. Opening a file and walking away contributes nothing. Expected review time scales with language complexity (Rust 2.0×, C++ 1.8×, TS/JS 1.5×, Python/Go 1.4×).

### What is hard-ignored

Never counted, at any layer — collection, aggregation, and reporting:

- **Dependencies:** `node_modules`, `bower_components`, site-packages
- **Python envs:** `venv`, `.venv`, `env`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`
- **Build output:** `dist`, `build`, `out`, `coverage`, `.nyc_output`, `.next`, `target`, `vendor`
- **VCS & IDE:** `.git`, `.hg`, `.svn`, `.idea`, `.vs`
- **Lockfiles:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, `go.sum`, and others
- **Generated files:** `*.min.js`, `*.bundle.js`, `*.map`, `*.pyc`

`package.json` is the deliberate exception: it's skipped when npm rewrites it behind your back, but still tracked when you or an AI edit it in the editor.

Historical data from before this list existed is purged automatically on startup and daily, with affected daily metrics recalculated. Force it with `CodeVibe: Purge Excluded-Path Data`.

---

## The report

```json
{
  "reportVersion": "1.0",
  "assignmentId": "asgn-hw3-2026",
  "assignmentName": "HW3 - Binary Search Trees",
  "generatedAt": 1790613483000,
  "studentIdentifier": "student-042",
  "repoUrl": "https://github.com/student/hw3",
  "repoHeadCommit": "4f9c1a2e7b3d…",
  "metrics": {
    "authorship": {
      "totalLines": 348, "manualLines": 284,
      "permittedAILines": 52, "prohibitedAILines": 0, "flaggedAILines": 12,
      "authorshipPercentage": 18.4, "prohibitedPercentage": 0
    },
    "ownership": {
      "score": 92, "filesReviewed": 4, "filesUnreviewed": 0,
      "unreviewedLines": 0, "averageReviewTimeMs": 18400
    },
    "violations": [],
    "trackingGaps": []
  },
  "policy": {
    "maxAuthorshipPercentage": 30,
    "minOwnershipScore": 40,
    "exemptFileGlobs": ["**/README*", "**/node_modules/**", "…"],
    "prohibitedMethods": ["external-file-change", "git-commit-marker"],
    "permittedMethods": ["inline-completion-api"],
    "flaggedMethods": ["large-paste", "change-velocity"]
  },
  "exclusionAudit": [
    { "timestamp": 1789484520000, "globs": [], "source": "assignment-activated" },
    { "timestamp": 1790049060000, "globs": ["**/generated/**"], "source": "settings" }
  ],
  "integrity": { "algorithm": "sha256", "hash": "a57f46b…" }
}
```

`exclusionAudit` is new. Entries sourced from `settings` record student attempts to add ignore rules; they have no effect during an active assignment.

### Violation types

| Type | Severity | Meaning |
|---|---|---|
| `agentic-use` | high | Files modified by an external agent, or AI commit markers |
| `authorship-exceeded` | medium | AI authorship above `maxAuthorshipPercentage` |
| `ownership-below-minimum` | medium | Review score below `minOwnershipScore` |
| `unreviewed-large-paste` | medium | Large paste accepted with insufficient review time |
| `tracking-gap` | low | No tracked activity for 30+ minutes inside the window |

---

## Commands

The ones that matter:

| Command | Purpose |
|---|---|
| `CodeVibe: Open Dashboard` | Open the sidebar dashboard |
| `CodeVibe: Create / Activate / Deactivate Assignment` | Manage assignment scoping |
| `CodeVibe: Export Assignment Report` | Write the `*.report.json` to submit |
| `CodeVibe: Show Assignment Status` | Current numbers and violations |
| `CodeVibe: Purge Excluded-Path Data` | Remove historical `node_modules`/venv rows |
| `CodeVibe: Clear All Data` | Delete every database and baseline file |
| `CodeVibe: Change Experience Level` | Junior / mid / senior thresholds |
| `CodeVibe: Snooze Alerts for Today` | Silence coaching for the day |
| `CodeVibe: Cleanup Old Data` | Enforce the 30-day retention window |

<details>
<summary>Everything else (~20 more)</summary>

`Start Onboarding` · `Reset Onboarding (Debug)` · `Open Settings` · `Refresh Dashboard` · `Show Quick Stats` · `Show Database Info` · `Show Progression & Level` · `Show Achievements` · `Advanced Settings` · `Export Data` · `Import Data` · `Show Snooze Status` · `Force Full Scan` · `Reset Achievements` · `Check Thresholds` · `Test Notifications (Debug)`

</details>

---

## Configuration

`Cmd/Ctrl+,` → search **CodeVibe**.

| Setting | Default | What it does |
|---|---|---|
| `codePause.experienceLevel` | `mid` | `junior` / `mid` / `senior` — sets daily AI target (40% / 60% / 75%) |
| `codePause.blindApprovalThreshold` | `2000` | ms before a fast acceptance is flagged |
| `codePause.alertFrequency` | `medium` | `low` / `medium` / `high` coaching interruptions |
| `codePause.anonymizePaths` | `true` | Store workspace-relative paths, not absolute ones |
| `codePause.enableGamification` | `false` | Achievements and progression |
| `codePause.trackedTools` | all `true` | Which assistants to monitor |
| `codePause.excludedGlobs` | `[]` | Extra ignore globs — **ignored during active assignments** |

---

## Privacy

**There is no telemetry, and there is no server.** Not disabled — removed from the codebase. There is no endpoint to turn off, no anonymous ID, no usage ping, nothing to opt out of. This is an independently maintained fork with no relationship to any telemetry infrastructure.

You can verify that in about thirty seconds:

```bash
# Nothing in the source does any network I/O at all
grep -rn "fetch(\|XMLHttpRequest\|https://api\." src/ --include="*.ts"
# → no matches
```

### What CodeVibe stores

Everything lives in `~/.codepause/` as SQLite, one database per project.

| | |
|---|---|
| **Stored** | Line counts, timestamps, review scores, event types, file paths |
| **Never stored** | Source code, file contents, prompts, diffs, commit messages |
| **Network** | None. No request is made at any point. |
| **Retention** | 30 days rolling |

The only file path CodeVibe ever reads is the one VS Code tells it about, and it reads nothing inside it — no content, ever. Just how many lines changed.

### Paths are anonymized by default

`codePause.anonymizePaths` is on out of the box, and it's genuinely applied:

| Path | Stored as |
|---|---|
| `/Users/alex/code/company-api/src/auth/login.ts` | `src/auth/login.ts` |
| `/Users/alex/notes/idea.txt` | `~/notes/idea.txt` |
| `/tmp/scratch.txt` | `/tmp/scratch.txt` (outside workspace and `$HOME` — kept so the dashboard can still open it) |

Absolute paths embed your OS username and your employer's directory names. Those never reach the database. Upgrading from an older version migrates the existing rows on first launch, so historical data is cleaned up too.

Turning it off stores full paths and lets `CodeVibe: Open File` style flows work identically, at the cost of the disclosure. There's no case where I'd recommend it.

### Errors stay on your machine

`ErrorReporter` writes to a local output channel and, if you click **Report Bug**, opens a GitHub issue form in your browser with the details pre-filled. It never contacts anything itself. Stack traces and context stay in the output channel until you choose to share them.

### Leaving

`CodeVibe: Clear All Data` deletes every database and baseline file. Deleting `~/.codepause/` does the same. Nothing is retained anywhere else, because there is nowhere else.

---

## Requirements & build

VS Code `^1.85.0`, Node `>=20`. A git repository is strongly recommended — without it, detection falls back to line-count baselines, which is less precise and will warn you on launch.

```bash
git clone https://github.com/waka-man/codevibe.git
cd codevibe
npm install
npm run compile
npm test              # 1730 tests, 56 suites
```

<details>
<summary>Development</summary>

```
npm run compile      # tsc -p ./
npm run watch        # tsc --watch
npm run lint         # eslint src --ext ts
npm test             # jest --coverage
npx @vscode/vsce package
```

**Layout** — `src/storage` (SQLite via `sql.js` WASM) · `src/core` (`MetricsCollector` hub, review scoring) · `src/trackers` (`UnifiedAITracker`, the file watcher) · `src/detection` (`AIDetector`, `ManualDetector`) · `src/assignments` (manager, policy engine, report generator) · `src/cli` (standalone verifier) · `src/utils` (`ExcludedPaths`, `PathAnonymizer`).

**Coverage** is enforced at build time — a global floor plus per-file pins on the modules that decide graded numbers, so a coverage collapse in `FileReviewSessionTracker` or `verify.ts` can't hide behind a healthy global average.

</details>

---

## License

**Business Source License 1.1** — free for personal, educational, and research use, and for internal company use. Production use is permitted except for offering a competing commercial product or service. Converts to **Apache 2.0 on 2027-01-04**. See [`LICENSE.md`](LICENSE.md).

---

<div align="center">

**CodeVibe is a ledger, not a judge.**

Pause. Review. Own your code. Then let the hash speak.

[Report a bug](https://github.com/waka-man/codevibe/issues) · [Discussions](https://github.com/waka-man/codevibe/discussions)

</div>
