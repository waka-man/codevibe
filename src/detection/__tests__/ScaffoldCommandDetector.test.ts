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
    'npx sv create "my app"',
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
    'echo "hello; npx sv create demo"',
    'printf "%s\\n" "ng new shop"',
    'cd app && npx sv create demo',
    'npm run build; ng new shop',
    'npx sv create app && codex "write the router"',
    'npx sv create app && claude',
    'npx sv create app; npm run build',
    'npx sv create "$(pwd)/app"',
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
    expect(tracker.isActiveFor('/repo/app/src/main.ts', true, 2_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app/src/existing.ts', false, 2_000)).toBe(false);
    expect(tracker.isActiveFor('/repo/src/unrelated.ts', true, 2_000)).toBe(false);
    expect(tracker.isActiveFor('/other/src/main.ts', true, 2_000)).toBe(false);
    expect(tracker.isActiveFor('/repo-other/src/main.ts', true, 2_000)).toBe(false);

    tracker.end(exec, 10_000);
    expect(tracker.isActiveFor('/repo/app/src/main.ts', true, 14_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app/src/main.ts', true, 15_001)).toBe(false);
    expect(tracker.isActiveFor('/other/src/main.ts', true, 14_000)).toBe(false);
  });

  it('does not track commands without a safely scopeable cwd', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    expect(tracker.start({}, 'npx sv create app')).toBe(false);
    expect(tracker.isActiveFor('/repo/app.ts', true, 2_000)).toBe(false);
  });

  it('bounds suppression even if a scaffolder waits for input', () => {
    const tracker = new ScaffoldActivityTracker(5_000, 10_000);
    const exec = {};
    expect(tracker.start(exec, 'npx sv create app', '/repo', 1_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app/main.ts', true, 11_000)).toBe(true);
    expect(tracker.isActiveFor('/repo/app/main.ts', true, 11_001)).toBe(false);
  });

  it('ignores non-scaffold commands', () => {
    const tracker = new ScaffoldActivityTracker(5_000);
    const exec = {};
    expect(tracker.start(exec, 'pnpm dev', '/repo')).toBe(false);
    expect(tracker.start(exec, 'npx sv create app && codex "write"', '/repo')).toBe(false);
    tracker.end(exec, 1_000);
    expect(tracker.isActive(100_000)).toBe(false);
  });

  it.each([
    ['npx -y create-next-app@latest app', '/repo/app'],
    ['npx degit sveltejs/template app', '/repo/app'],
    ['pnpm dlx create-turbo@latest', '/repo'],
    ['npm create vite@latest my-app -- --template react', '/repo/my-app'],
    ['npm init vue@latest app', '/repo/app'],
    ['ng new shop', '/repo/shop'],
    ['npx @angular/cli new shop', '/repo/shop'],
    ['django-admin startproject site', '/repo/site'],
    ['python manage.py startapp app', '/repo/app'],
    ['cargo new cli', '/repo/cli'],
    ['dotnet new console -o src/App', '/repo/src/App'],
    ['dotnet new webapi', '/repo'],
    ['flutter create app', '/repo/app'],
    ['composer create-project vendor/package dir', '/repo/dir'],
    ['git clone https://github.com/org/repo.git', '/repo/repo'],
    ['git clone https://github.com/org/repo.git custom', '/repo/custom'],
    ['go mod init example.com/app', '/repo'],
  ])('scopes "%s" to newly created files under %s', (command, root) => {
    const tracker = new ScaffoldActivityTracker();
    expect(tracker.start({}, command, '/repo')).toBe(true);
    expect(tracker.isActiveFor(`${root}/generated.ts`, true)).toBe(true);
    expect(tracker.isActiveFor(`${root}/existing.ts`, false)).toBe(false);
  });

  it.each([
    'npx sv create ../outside',
    'npx sv create /absolute',
    'npx sv create C:/absolute',
    'npx unknown-generator app',
    'npx sv create "unterminated',
    'git clone',
  ])('does not suppress files for unsafe or unparseable target "%s"', (command) => {
    const tracker = new ScaffoldActivityTracker();
    expect(tracker.start({}, command, '/repo')).toBe(false);
  });
});
