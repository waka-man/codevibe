import {
  clearGeneratedOutputs,
  isGeneratedOutput,
  registerGeneratedOutput,
} from '../GeneratedOutputGuard';

describe('GeneratedOutputGuard', () => {
  beforeEach(() => clearGeneratedOutputs());
  afterEach(() => clearGeneratedOutputs());

  it('suppresses only an exact registered export destination', () => {
    const target = {
      fsPath: '/repo/submission/evidence file.json',
      toString: () => 'file:///repo/submission/evidence%20file.json',
    };
    registerGeneratedOutput(target);

    expect(isGeneratedOutput(target.fsPath)).toBe(true);
    expect(isGeneratedOutput(target)).toBe(true);
    expect(isGeneratedOutput('/repo/submission/other.json')).toBe(false);
    expect(isGeneratedOutput({ fsPath: '/repo/submission/other.json' })).toBe(false);
    expect(isGeneratedOutput('/repo/audit.report.json')).toBe(false);
    expect(isGeneratedOutput(undefined)).toBe(false);
  });

  it('rolls back registration when a write fails', () => {
    const rollback = registerGeneratedOutput('/repo/submission/evidence.json');
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    rollback();

    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });

  it('preserves case on case-sensitive platforms', () => {
    registerGeneratedOutput('/repo/src/App.ts');

    expect(isGeneratedOutput('/repo/src/App.ts')).toBe(true);
    expect(isGeneratedOutput('/repo/src/app.ts')).toBe(
      process.platform === 'win32',
    );
  });

  it('clears exact registrations', () => {
    registerGeneratedOutput('/repo/submission/evidence.json');
    clearGeneratedOutputs();

    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });
});
