import {
  clearGeneratedOutputs,
  isGeneratedOutput,
  registerGeneratedOutput,
} from '../GeneratedOutputGuard';

describe('GeneratedOutputGuard', () => {
  beforeEach(() => clearGeneratedOutputs());
  afterEach(() => {
    clearGeneratedOutputs();
    jest.useRealTimers();
  });

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
    const registration = registerGeneratedOutput('/repo/submission/evidence.json');
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    registration.rollback();

    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });

  it('keeps overlapping registrations protected until all writers roll back', () => {
    const first = registerGeneratedOutput('/repo/submission/evidence.json');
    const second = registerGeneratedOutput('/repo/submission/evidence.json');

    first.rollback();
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    second.rollback();
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });

  it('expires a completed write after the deferred watcher window', () => {
    jest.useFakeTimers();
    const registration = registerGeneratedOutput('/repo/submission/evidence.json');

    registration.complete();
    jest.advanceTimersByTime(5_000);
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    jest.advanceTimersByTime(10_001);
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });

  it('does not expire an overlapping write that is still in progress', () => {
    jest.useFakeTimers();
    const first = registerGeneratedOutput('/repo/submission/evidence.json');
    const second = registerGeneratedOutput('/repo/submission/evidence.json');

    first.complete();
    jest.advanceTimersByTime(30_000);
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);

    second.rollback();
    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(false);
  });

  it('does not let a stale rollback remove a newer registration', () => {
    const stale = registerGeneratedOutput('/repo/submission/evidence.json');
    clearGeneratedOutputs();
    registerGeneratedOutput('/repo/submission/evidence.json');

    stale.rollback();

    expect(isGeneratedOutput('/repo/submission/evidence.json')).toBe(true);
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
