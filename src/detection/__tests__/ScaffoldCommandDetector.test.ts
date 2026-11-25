/**
 * ScaffoldCommandDetector tests - project generators are not AI (#34)
 */

import {
  isScaffoldCommand,
  ScaffoldActivityTracker,
} from '../ScaffoldCommandDetector';

describe('isScaffoldCommand', () => {
  it.each([
    'npx sv create my-app',
    'npx sv@latest create my-app',
    'npm create vite@latest my-app -- --template react',
    'pnpm create svelte@latest',
    'yarn create next-app',
    'bun create astro',
    'npm init vue@latest',
    'npx create-react-app web',
    'npx -y create-next-app@latest app',
    'pnpm dlx create-turbo@latest',
    'npx degit sveltejs/template app',
    'ng new shop',
    'npx @angular/cli new shop',
    'django-admin startproject site',
    'cargo new cli',
    'dotnet new console',
    'flutter create app',
    'git clone https://github.com/org/repo.git',
    'cd app && npx sv create demo',
    'npm run build; ng new shop',
  ])('recognises "%s"', (cmd) => {
    expect(isScaffoldCommand(cmd)).toBe(true);
  });

  it.each([
    'pnpm dev',
    'npm run build',
    'vite dev',
    'npm install lodash',
    'claude',
    'codex "write the router"',
    'node scripts/create-user.js',
    'git commit -m "create routes"',
    'echo "npx sv create demo"',
    'printf "%s\\n" "ng new shop"',
    '',
  ])('does not treat "%s" as scaffolding', (cmd) => {
    expect(isScaffoldCommand(cmd)).toBe(false);
  });
});

describe('ScaffoldActivityTracker', () => {
  it('is active only inside the scaffolder cwd while running and during grace', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    const exec = {};
    expect(tracker.isActive(1_000)).toBe(false);

    expect(tracker.start(exec, 'npx sv create app', '/repo')).toBe(true);
    expect(tracker.isActiveFor('/repo/app/src/main.ts', 2_000)).toBe(true);
    expect(tracker.isActiveFor('/other/src/main.ts', 2_000)).toBe(false);
    expect(tracker.isActiveFor('/repo-other/src/main.ts', 2_000)).toBe(false);

    tracker.end(exec, 10_000);
    expect(tracker.isActiveFor('/repo/app/src/main.ts', 14_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app/src/main.ts', 15_001)).toBe(false);
    expect(tracker.isActiveFor('/other/src/main.ts', 14_000)).toBe(false);
  });

  it('does not track commands without a safely scopeable cwd', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    expect(tracker.start({}, 'npx sv create app')).toBe(false);
    expect(tracker.isActiveFor('/repo/app.ts', 2_000)).toBe(false);
  });

  it('bounds suppression even if a scaffolder waits for input', () => {
    const tracker = new ScaffoldActivityTracker(5_000, 10_000);
    const exec = {};
    expect(tracker.start(exec, 'npx sv create app', '/repo', 1_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app.ts', 11_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app.ts', 11_001)).toBe(false);
  });

  it('ignores non-scaffold commands', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    const exec = {};
    expect(tracker.start(exec, 'pnpm dev', '/repo')).toBe(false);
    tracker.end(exec, 1_000);
    expect(tracker.isActive(100_000)).toBe(false);
  });
});
