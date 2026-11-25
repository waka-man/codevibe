/**
 * ExcludedPaths tests - hard-ignore list for generated/dependency dirs
 */

import {
  isExcludedFile,
  isExcludedBySegment,
  isLockfile,
  isPackageManagerManifestFile,
  matchExclusionGlob,
  DEFAULT_EXCLUDED_GLOBS,
  validateCustomExclusions,
  sanitizeCustomExclusions,
} from '../ExcludedPaths';

describe('ExcludedPaths', () => {
  describe('isExcludedFile - JS/TS dependencies', () => {
    it('excludes nested node_modules files (posix)', () => {
      expect(isExcludedFile('/proj/node_modules/lodash/lodash.js')).toBe(true);
    });

    it('excludes nested node_modules files (windows)', () => {
      expect(isExcludedFile('C:\\proj\\node_modules\\react\\index.js')).toBe(true);
    });

    it('excludes deeply nested node_modules paths', () => {
      expect(isExcludedFile('/proj/node_modules/.bin/tsc')).toBe(true);
    });

    it('does not exclude lookalike directory names', () => {
      expect(isExcludedFile('/proj/my-node_modules-backup/app.ts')).toBe(false);
      expect(isExcludedFile('/proj/src/node_modules_helper.ts')).toBe(false);
    });

    it('does not exclude regular source files', () => {
      expect(isExcludedFile('/proj/src/app.ts')).toBe(false);
    });
  });

  describe('isExcludedFile - Python environments', () => {
    it.each([
      '/proj/venv/lib/python3.12/site-packages/requests/api.py',
      '/proj/.venv/lib/python3.12/site-packages/numpy/core.py',
      '/proj/env/bin/activate',
      '/proj/pkg/__pycache__/module.cpython-312.pyc',
      '/proj/pkg/module.pyc',
      '/proj/.tox/py312/lib/x.py',
      '/proj/.mypy_cache/3.12/app.data.json',
      '/proj/.pytest_cache/v/cache/lastfailed',
    ])('excludes %s', (p) => {
      expect(isExcludedFile(p)).toBe(true);
    });

    it('does not exclude a venv-named source file', () => {
      expect(isExcludedFile('/proj/src/venv_config.py')).toBe(false);
    });
  });

  describe('isExcludedFile - build outputs & VCS (v1 defaults)', () => {
    it.each([
      '/proj/dist/bundle.js',
      '/proj/build/output.js',
      '/proj/out/extension.js',
      '/proj/coverage/lcov-report/index.html',
      '/proj/.next/static/chunk.js',
      '/proj/target/debug/app',
      '/proj/vendor/lib.c',
      '/proj/.git/objects/ab/cd',
      '/proj/.idea/workspace.xml',
      '/proj/app.min.js',
      '/proj/app.bundle.js',
      '/proj/app.js.map',
    ])('excludes %s', (p) => {
      expect(isExcludedFile(p)).toBe(true);
    });
  });

  describe('isExcludedFile - edge cases', () => {
    it('returns false for empty/undefined paths', () => {
      expect(isExcludedFile('')).toBe(false);
      expect(isExcludedFile(undefined)).toBe(false);
      expect(isExcludedFile(null)).toBe(false);
    });

    it('is case-insensitive for segments', () => {
      expect(isExcludedFile('/proj/NODE_MODULES/pkg/index.js')).toBe(true);
      expect(isExcludedFile('/proj/Venv/lib/x.py')).toBe(true);
    });
  });

  describe('extra user globs', () => {
    it('matches caller-supplied globs', () => {
      expect(isExcludedFile('/proj/generated/types.ts', ['**/generated/**'])).toBe(true);
      expect(isExcludedFile('/proj/src/app.ts', ['**/generated/**'])).toBe(false);
    });

    it('ignores empty glob entries', () => {
      expect(isExcludedFile('/proj/src/app.ts', ['', undefined as any])).toBe(false);
    });
  });

  describe('helpers', () => {
    it('isExcludedBySegment matches exact segments only', () => {
      expect(isExcludedBySegment('/a/node_modules/b')).toBe(true);
      expect(isExcludedBySegment('/a/node_modules_backup/b')).toBe(false);
    });

    it('matchExclusionGlob supports ** and *', () => {
      expect(matchExclusionGlob('/proj/generated/types.ts', '**/generated/**')).toBe(true);
      expect(matchExclusionGlob('/proj/src/a.ts', '**/*.md')).toBe(false);
    });
  });

  // Issue #36: globs entered as the reporter did never matched, because they
  // were compared against the whole absolute path.
  describe('matchExclusionGlob - project-relative user globs (#36)', () => {
    const file = '/Users/dev/web-infra/.svelte-kit/generated/client/app.js';

    it.each(['.svelte-kit', '/.svelte-kit', './.svelte-kit/', '.svelte-kit/**', '**/.svelte-kit/**'])(
      '"%s" excludes files under .svelte-kit',
      (glob) => {
        expect(matchExclusionGlob(file, glob)).toBe(true);
        expect(matchExclusionGlob('C:\\web-infra\\.svelte-kit\\types\\x.d.ts', glob)).toBe(true);
        expect(matchExclusionGlob('.svelte-kit/output/a.js', glob)).toBe(true);
      },
    );

    it('matches at segment boundaries only', () => {
      expect(matchExclusionGlob('/proj/my.svelte-kit-notes/a.ts', '.svelte-kit')).toBe(false);
      expect(matchExclusionGlob('/proj/src/routes/+page.svelte', '.svelte-kit')).toBe(false);
    });

    it('supports relative sub-paths and file patterns', () => {
      expect(matchExclusionGlob('/proj/src/generated/api.ts', 'src/generated/**')).toBe(true);
      expect(matchExclusionGlob('/proj/src/app.ts', 'src/generated/**')).toBe(false);
      expect(matchExclusionGlob('/proj/logs/today.log', '*.log')).toBe(true);
      expect(matchExclusionGlob('/proj/src/a.ts', '*.log')).toBe(false);
    });

    it('treats regex characters in globs literally', () => {
      expect(matchExclusionGlob('/proj/src/routes/+page.svelte', 'routes/+page.svelte')).toBe(true);
      expect(matchExclusionGlob('/proj/src/routes/xpage.svelte', 'routes/+page.svelte')).toBe(false);
      expect(matchExclusionGlob('/proj/a.b/c.ts', 'a.b')).toBe(true);
      expect(matchExclusionGlob('/proj/axb/c.ts', 'a.b')).toBe(false);
    });
  });

  describe('validateCustomExclusions - multi-pattern entries (#36)', () => {
    it('splits one entry holding several space- or comma-separated globs', () => {
      const { valid } = validateCustomExclusions(['.svelte-kit/** build/** dist/**', 'a/**, b/**']);
      expect(valid).toEqual(['.svelte-kit/**', 'build/**', 'dist/**', 'a/**', 'b/**']);
    });

    it.each(['/**', './**/', '/', '**/*/', './*'])('rejects universe pattern "%s"', (glob) => {
      const { valid, rejected } = validateCustomExclusions([glob]);
      expect(valid).toEqual([]);
      expect(rejected[0].reason).toMatch(/matches everything/);
    });
  });

  describe('framework build caches (#35)', () => {
    it.each([
      '/proj/.svelte-kit/generated/client/nodes/2.js',
      '/proj/.vite/deps/chunk.js',
      '/proj/.turbo/cache/x.json',
      '/proj/.angular/cache/x.js',
      '/proj/.output/server/index.mjs',
      '/proj/.astro/types.d.ts',
    ])('excludes %s by default', (p) => {
      expect(isExcludedFile(p)).toBe(true);
    });

    it('mirrors the new segments in DEFAULT_EXCLUDED_GLOBS', () => {
      expect(DEFAULT_EXCLUDED_GLOBS).toContain('**/.svelte-kit/**');
    });
  });

  // Issue #37: pnpm's virtual store
  it('excludes pnpm virtual-store paths', () => {
    expect(
      isExcludedFile('/Users/dev/web-infra/node_modules/.pnpm/@sveltejs+kit@2.5.0/node_modules/vite/bin/vite.js'),
    ).toBe(true);
  });

  describe('DEFAULT_EXCLUDED_GLOBS', () => {
    it('covers node_modules, venv variants, and build outputs', () => {
      const globs = [...DEFAULT_EXCLUDED_GLOBS];
      for (const expected of [
        '**/node_modules/**',
        '**/venv/**',
        '**/.venv/**',
        '**/__pycache__/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
      ]) {
        expect(globs).toContain(expected);
      }
    });

    it('covers package-manager lockfiles', () => {
      const globs = [...DEFAULT_EXCLUDED_GLOBS];
      for (const expected of [
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
        '**/poetry.lock',
        '**/Pipfile.lock',
        '**/Gemfile.lock',
        '**/Cargo.lock',
        '**/composer.lock',
        '**/go.sum',
      ]) {
        expect(globs).toContain(expected);
      }
    });
  });

  describe('lockfiles (npm/pip/cargo/go writes, not AI)', () => {
    it.each([
      '/proj/package-lock.json',
      '/proj/yarn.lock',
      '/proj/pnpm-lock.yaml',
      '/proj/poetry.lock',
      '/proj/Pipfile.lock',
      '/proj/Gemfile.lock',
      '/proj/Cargo.lock',
      '/proj/composer.lock',
      '/proj/go.sum',
      'C:\\proj\\package-lock.json',
    ])('hard-ignores %s', (p) => {
      expect(isLockfile(p)).toBe(true);
      expect(isExcludedFile(p)).toBe(true);
    });

    it('does not mistake source files for lockfiles', () => {
      expect(isLockfile('/proj/src/app.ts')).toBe(false);
      expect(isLockfile('/proj/package.json')).toBe(false);
      expect(isLockfile('/proj/lockfile-helper.ts')).toBe(false);
    });
  });

  describe('package.json manifest (npm rewrites it externally)', () => {
    it('is detected as a package-manager manifest', () => {
      expect(isPackageManagerManifestFile('/proj/package.json')).toBe(true);
      expect(isPackageManagerManifestFile('C:\\proj\\package.json')).toBe(true);
    });

    it('is NOT hard-ignored (in-editor edits still tracked)', () => {
      expect(isExcludedFile('/proj/package.json')).toBe(false);
    });

    it('rejects non-manifests', () => {
      expect(isPackageManagerManifestFile('/proj/package-lock.json')).toBe(false);
      expect(isPackageManagerManifestFile('/proj/src/app.ts')).toBe(false);
      expect(isPackageManagerManifestFile(undefined)).toBe(false);
    });
  });

  describe('validateCustomExclusions (anti-evasion)', () => {
    it('accepts legitimate narrow globs', () => {
      const { valid, rejected } = validateCustomExclusions(['**/generated/**', '**/migrations/*.ts']);
      expect(valid).toEqual(['**/generated/**', '**/migrations/*.ts']);
      expect(rejected).toEqual([]);
    });

    it.each(['**', '*', '**/*', '**/**', '.', '/', './**'])(
      'rejects universe pattern %s',
      (glob) => {
        const { valid, rejected } = validateCustomExclusions([glob]);
        expect(valid).toEqual([]);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatch(/everything/);
      },
    );

    it('rejects empty, duplicate, and overlong entries', () => {
      const { valid, rejected } = validateCustomExclusions([
        '',
        '**/generated/**',
        '**/generated/**',
        'x'.repeat(201),
      ]);
      expect(valid).toEqual(['**/generated/**']);
      expect(rejected).toHaveLength(3);
    });

    it('caps the number of custom exclusions', () => {
      const many = Array.from({ length: 60 }, (_, i) => `**/dir${i}/**`);
      const { valid, rejected } = validateCustomExclusions(many);
      expect(valid).toHaveLength(50);
      expect(rejected).toHaveLength(10);
    });

    it('handles undefined input', () => {
      expect(validateCustomExclusions(undefined)).toEqual({ valid: [], rejected: [] });
    });

    it('sanitizeCustomExclusions returns only the safe subset', () => {
      expect(sanitizeCustomExclusions(['**', '**/generated/**'])).toEqual(['**/generated/**']);
    });
  });
});
