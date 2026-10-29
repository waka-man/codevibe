/**
 * Apply stored custom thresholds (max AI percentage, min review time) onto a
 * ThresholdManager. ThresholdManager is constructed with level defaults only;
 * this overlays any user-configured custom thresholds so they actually take effect.
 * Values are clamped by the ThresholdManager setters.
 *
 * Fixes: custom thresholds set in settings (e.g. max AI percentage = 20%) were
 * silently ignored because ThresholdManager was initialized with level defaults
 * and never overlaid with the stored custom values.
 */

import { ThresholdManager } from '../core/ThresholdManager';

export interface CustomThresholdsProvider {
  getCustomThresholds(): {
    aiPercentageMax?: number;
    reviewTimeMin?: number;
  };
}

export function applyStoredCustomThresholds(
  thresholdManager: ThresholdManager,
  config: CustomThresholdsProvider,
): void {
  const custom = config.getCustomThresholds();
  if (custom.aiPercentageMax !== undefined) {
    thresholdManager.setMaxAIPercentage(custom.aiPercentageMax);
  }
  if (custom.reviewTimeMin !== undefined) {
    thresholdManager.setMinReviewTime(custom.reviewTimeMin);
  }
}
