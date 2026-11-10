module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/test/**',
    '!src/extension.ts', // Integration test only
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Coverage floor. Set slightly below the measured totals (88/78/90/88) so
  // normal edits cannot fail the build, but a real drop in test coverage does.
  //
  // The modules that decide graded numbers are pinned individually and much
  // higher, because the global average can hide a collapse in one of them:
  //   - FileReviewSessionTracker produces the review scores behind
  //     minOwnershipScore verdicts.
  //   - verify.ts is the anti-tamper CLI; its exit codes are the security
  //     contract for submitted reports.
  //   - AssignmentManager decides which files are exempt from authorship.
  //   - ExcludedPaths / PathAnonymizer gate data collection and privacy.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 75,
      functions: 87,
      lines: 85,
    },
    './src/core/FileReviewSessionTracker.ts': {
      statements: 90,
      branches: 85,
      functions: 95,
      lines: 90,
    },
    './src/cli/verify.ts': {
      statements: 90,
      branches: 80,
      functions: 95,
      lines: 90,
    },
    './src/assignments/AssignmentManager.ts': {
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    },
    './src/assignments/PolicyEngine.ts': {
      statements: 90,
      branches: 80,
      functions: 95,
      lines: 90,
    },
    './src/detection/AIDetector.ts': {
      statements: 90,
      branches: 75,
      functions: 95,
      lines: 90,
    },
    './src/utils/ExcludedPaths.ts': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    './src/utils/PathAnonymizer.ts': {
      statements: 90,
      branches: 80,
      functions: 95,
      lines: 90,
    },
    './src/assignments/AssignmentReportGenerator.ts': {
      statements: 85,
      branches: 75,
      functions: 95,
      lines: 85,
    },
  },
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
      },
    }],
  },
};
