# VSIX Auto-Updater

## Goal

Reduce the manual burden of distributing CodeVibe VSIX updates while preserving student control, offline safety, and the existing local-data contract.

## Scope

Implement a custom updater on the `feat-auto-updating` branch for GitHub Releases from `waka-man/codevibe`.

The updater supports:

- Silent update checks after activation.
- A manual `CodeVibe: Check for Updates` command.
- A dashboard update-check button.
- Release-note preview before installation.
- VSIX download and installation through VS Code's built-in command.
- Reload notification after installation.

## Release Contract

The latest GitHub release API response is the update manifest source. A valid release must provide:

- A semantic version tag such as `v0.1.13`.
- A published release.
- At least one `.vsix` asset.
- Release notes from the release body.

The installed version comes from the extension package metadata. Version comparison is semantic and must not treat `0.1.10` as newer than `0.1.12`.

## Architecture

`UpdateService` owns:

- GitHub latest-release retrieval.
- Response validation.
- Semantic version comparison.
- Per-session check throttling and suppression of already-dismissed versions.
- VSIX download to a temporary file.
- VSIX installation through `workbench.extensions.installExtension`.
- Cleanup of temporary files.

The extension entry point owns command registration and activation-time orchestration. `DashboardProvider` owns webview messages for manual checks and update details. Update metadata is represented by typed local interfaces.

## User Flow

### Startup

After activation succeeds, schedule a non-blocking update check. Network errors are logged locally and never prevent activation. If an update exists, show a notification with `Update now` and `Later` actions. `Later` suppresses the same version for the current session.

### Manual Check

The command and dashboard button always perform a check, subject to an in-flight request guard. A current-version result shows an up-to-date notification. An available update shows the release version and notes, with actions to install or cancel.

### Installation

1. Confirm the selected release and display release notes.
2. Download the selected `.vsix` asset to a unique temporary path.
3. Validate that the response is successful and the asset is non-empty.
4. Invoke VS Code's VSIX installation command.
5. Remove the temporary file in a `finally` path.
6. Prompt to reload the window after a successful installation.

Release notes are inserted into the webview using text-safe rendering. They are never treated as executable HTML or script.

## Failure Handling

- GitHub unavailable: show an error only for manual checks; silently log startup failures.
- Invalid API response: reject the update and explain that release metadata is invalid.
- No VSIX asset: report that the release cannot be installed.
- Download failure: preserve the current extension and report the failure.
- Installation failure: report the failure and do not claim that the update succeeded.
- Reload cancellation: leave the installed extension in place and explain that reload is still required to activate it.

## Configuration

Add configuration for:

- Enable/disable automatic checks, default `true`.
- Automatic check interval/cooldown, with a conservative default.
- Optional release repository override for testing or forks, defaulting to `waka-man/codevibe`.

No credentials or GitHub token are required for public releases.

## Testing

Unit tests cover version comparison, manifest validation, missing assets, malformed responses, network failures, throttling, suppression, release-note safety, and temporary-file cleanup. Extension command tests cover manual checks, startup failures, install invocation, reload prompting, and dashboard message handling.

Manual Extension Development Host verification covers:

- No update available.
- Update available with release notes.
- Successful VSIX installation and reload prompt.
- Failed network/download/install flows.
