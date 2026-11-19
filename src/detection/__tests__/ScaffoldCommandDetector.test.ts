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
    '',
  ])('does not treat "%s" as scaffolding', (cmd) => {
    expect(isScaffoldCommand(cmd)).toBe(false);
  });
});

describe('ScaffoldActivityTracker', () => {
  it('is active while a scaffolder runs and for the grace period after', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    const exec = {};
    expect(tracker.isActive(1_000)).toBe(false);

    expect(tracker.start(exec, 'npx sv create app')).toBe(true);
    expect(tracker.isActive(2_000)).toBe(true);

    tracker.end(exec, 10_000);
    expect(tracker.isActive(14_000)).toBe(true);
    expect(tracker.isActive(15_001)).toBe(false);
  });

  it('ignores non-scaffold commands', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    const exec = {};
    expect(tracker.start(exec, 'pnpm dev')).toBe(false);
    tracker.end(exec, 1_000);
    expect(tracker.isActive(100_000)).toBe(false);
  });
});
