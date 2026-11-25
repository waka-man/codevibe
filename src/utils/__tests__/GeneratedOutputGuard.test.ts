import {
  clearGeneratedOutputs,
  isGeneratedOutput,
  registerGeneratedOutput,
} from '../GeneratedOutputGuard';

describe('GeneratedOutputGuard', () => {
  beforeEach(() => clearGeneratedOutputs());
  afterEach(() => clearGeneratedOutputs());

  it('recognises known CodeVibe export filenames without registration', () => {
    expect(isGeneratedOutput('/repo/hw1.report.json')).toBe(true);
    expect(isGeneratedOutput('C:\\repo\\codepause-export-123.json')).toBe(true);
    expect(isGeneratedOutput('/repo/codepause-metrics-123.json')).toBe(true);
    expect(isGeneratedOutput('/repo/codepause-config.json')).toBe(true);
    expect(isGeneratedOutput('/repo/src/app.ts')).toBe(false);
  });

  it('suppresses an arbitrary exact export destination', () => {
    const target = {
      fsPath: '/repo/submission/evidence file.json',
      toString: () => 'file:///repo/submission/evidence%20file.json',
    };
    registerGeneratedOutput(target);

    expect(isGeneratedOutput(target.fsPath)).toBe(true);
    expect(isGeneratedOutput(target)).toBe(true);
    expect(isGeneratedOutput('/repo/submission/other.json')).toBe(false);
    expect(isGeneratedOutput({ fsPath: '/repo/submission/other.json' })).toBe(false);
  });

  it('clears exact registrations but keeps filename rules', () => {
    registerGeneratedOutput('/repo/submission/evidence.json');
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    clearGeneratedOutputs();

    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
    expect(isGeneratedOutput('/repo/hw1.report.json')).toBe(true);
  });
});
