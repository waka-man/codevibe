/**
 * Unit tests for applyStoredCustomThresholds (extension wiring).
 *
 * Verifies that user-configured custom thresholds (max AI percentage,
 * min review time) are actually applied to ThresholdManager at activation
 * and on experience-level change, instead of being silently ignored in
 * favor of level defaults. (Issue #25: "ai and ownership refuse to change".)
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ThresholdManager } from '../ThresholdManager';
import { DeveloperLevel, DEFAULT_THRESHOLDS } from '../../types';
import { applyStoredCustomThresholds } from '../../utils/applyCustomThresholds';

// Minimal ConfigManager stub exposing only what applyStoredCustomThresholds needs
class ConfigManagerStub {
  private custom: {
    aiPercentageMax?: number;
    reviewTimeMin?: number;
  };
  constructor(custom: { aiPercentageMax?: number; reviewTimeMin?: number } = {}) {
    this.custom = custom;
  }
  getCustomThresholds() {
    return { ...this.custom };
  }
}

describe('applyStoredCustomThresholds', () => {
  let manager: ThresholdManager;
  let configManager: ConfigManagerStub;

  beforeEach(() => {
    manager = new ThresholdManager(DeveloperLevel.Mid);
    configManager = new ConfigManagerStub({});
  });

  it('applies custom max AI percentage over level default', () => {
    // Mid default is 60%
    expect(manager.getMaxAIPercentage()).toBe(60);

    configManager = new ConfigManagerStub({ aiPercentageMax: 20 });
    applyStoredCustomThresholds(manager, configManager);

    expect(manager.getMaxAIPercentage()).toBe(20);
  });

  it('applies custom min review time over level default', () => {
    // Mid default is 3000ms
    expect(manager.getMinReviewTime()).toBe(3000);

    configManager = new ConfigManagerStub({ reviewTimeMin: 1500 });
    applyStoredCustomThresholds(manager, configManager);

    expect(manager.getMinReviewTime()).toBe(1500);
  });

  it('applies both custom thresholds together', () => {
    configManager = new ConfigManagerStub({ aiPercentageMax: 25, reviewTimeMin: 1200 });
    applyStoredCustomThresholds(manager, configManager);

    expect(manager.getMaxAIPercentage()).toBe(25);
    expect(manager.getMinReviewTime()).toBe(1200);
  });

  it('leaves level defaults when no custom thresholds are set', () => {
    const defaults = DEFAULT_THRESHOLDS[DeveloperLevel.Mid];
    applyStoredCustomThresholds(manager, configManager);

    expect(manager.getMaxAIPercentage()).toBe(defaults.maxAIPercentage);
    expect(manager.getMinReviewTime()).toBe(defaults.minReviewTime);
  });

  it('clamps out-of-range custom AI percentage', () => {
    configManager = new ConfigManagerStub({ aiPercentageMax: 150 });
    applyStoredCustomThresholds(manager, configManager);

    // Clamped to 100 (ThresholdManager.setMaxAIPercentage max)
    expect(manager.getMaxAIPercentage()).toBe(100);
  });

  it('clamps out-of-range custom review time', () => {
    configManager = new ConfigManagerStub({ reviewTimeMin: 100 });
    applyStoredCustomThresholds(manager, configManager);

    // Clamped to 500 (ThresholdManager.setMinReviewTime min)
    expect(manager.getMinReviewTime()).toBe(500);
  });

  it('re-applies custom thresholds after setLevel resets to defaults', () => {
    // Simulate level change: setLevel resets Mid defaults, then custom thresholds reapplied
    manager.setLevel(DeveloperLevel.Senior);
    expect(manager.getMaxAIPercentage()).toBe(75); // Senior default

    configManager = new ConfigManagerStub({ aiPercentageMax: 30 });
    applyStoredCustomThresholds(manager, configManager);

    expect(manager.getMaxAIPercentage()).toBe(30); // Custom overrides Senior default
  });
});
