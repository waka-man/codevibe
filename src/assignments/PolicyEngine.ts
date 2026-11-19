/**
 * PolicyEngine
 * Classifies AI events and evaluates them against an assignment policy.
 */

import { matchesAnyGlob } from "../utils/globMatch";
import { addDays, startOfLocalDay } from "../utils/DateUtils";
import {
  TrackingEvent,
  Assignment,
  AssignmentPolicy,
  AssignmentMetrics,
  AssignmentAuthorship,
  AssignmentOwnership,
  PolicyEvaluation,
  PolicyViolation,
  PolicyViolationType,
  AIClassification,
  AIDetectionMethod,
  CodeSource,
  TrackingGap,
} from "../types";

/**
 * Detection methods that are never AI-authored. Editor-assisted ones are
 * emitted with CodeSource.Neutral (editor assistance is not proof of
 * authorship either way), so classification must not fall through to "flag"
 * and count them as AI lines.
 */
const NON_AI_DETECTION_METHODS = new Set([
  "manual",
  "manual-typing",
  "manual-deletion",
  "editor-undo-redo",
  "editor-assisted-change",
  "editor-refactoring",
]);

export interface PolicyEngineOptions {
  /** Number of milliseconds of inactivity before a tracking gap is recorded */
  gapThresholdMs?: number;
}

export class PolicyEngine {
  private readonly defaultGapThresholdMs: number;

  constructor(options: PolicyEngineOptions = {}) {
    this.defaultGapThresholdMs = options.gapThresholdMs ?? 30 * 60 * 1000;
  }

  /**
   * Classify a single AI event against the assignment policy.
   */
  classifyEvent(
    event: TrackingEvent,
    policy: AssignmentPolicy,
  ): PolicyEvaluation {
    const method = event.detectionMethod as AIDetectionMethod | undefined;

    if (!method) {
      return {
        classification: AIClassification.Permitted,
        reason: "No detection method recorded",
      };
    }

    if (
      event.source === CodeSource.Neutral ||
      NON_AI_DETECTION_METHODS.has(method)
    ) {
      return {
        classification: AIClassification.Permitted,
        reason: `${method} is a manual/editor-assisted edit, not AI-authored`,
      };
    }

    if (policy.prohibitedMethods.includes(method)) {
      return {
        classification: AIClassification.Prohibited,
        violationType: PolicyViolationType.AgenticUse,
        reason: `${method} is classified as prohibited agentic AI use`,
      };
    }

    if (policy.permittedMethods.includes(method)) {
      return {
        classification: AIClassification.Permitted,
        reason: `${method} is permitted as assisted coding`,
      };
    }

    if (policy.flaggedMethods.includes(method)) {
      // Large pastes without sufficient review become ownership violations later
      return {
        classification: AIClassification.Flag,
        reason: `${method} is flagged and requires review`,
      };
    }

    return {
      classification: AIClassification.Flag,
      reason: `${method} is not explicitly categorized by the policy`,
    };
  }

  /**
   * Compute full assignment metrics and violation list from raw events.
   */
  computeMetrics(
    assignment: Assignment,
    events: TrackingEvent[],
    fileReviews: any[],
  ): AssignmentMetrics {
    const policy = assignment.policy;
    const gapThresholdMs =
      policy.maxTrackingGapSeconds * 1000 || this.defaultGapThresholdMs;

    let totalLines = 0;
    let manualLines = 0;
    let permittedAILines = 0;
    let prohibitedAILines = 0;
    let flaggedAILines = 0;

    const violationMap = new Map<PolicyViolationType, PolicyViolation>();

    // Violation timestamps are derived from event data (never Date.now()) so
    // re-computing metrics from the same events yields identical reports.
    // On merge, the first message/details win so they always agree with each
    // other; occurrences are aggregated via count.
    const addViolation = (
      type: PolicyViolationType,
      severity: "low" | "medium" | "high",
      message: string,
      details: Record<string, unknown>,
      detectedAt: number,
    ) => {
      const existing = violationMap.get(type);
      if (existing) {
        existing.count++;
        existing.firstDetectedAt = Math.min(
          existing.firstDetectedAt,
          detectedAt,
        );
        existing.lastDetectedAt = Math.max(existing.lastDetectedAt, detectedAt);
      } else {
        violationMap.set(type, {
          type,
          severity,
          message,
          details,
          firstDetectedAt: detectedAt,
          lastDetectedAt: detectedAt,
          count: 1,
        });
      }
    };

    const aiFiles = new Map<
      string,
      { reviewScore: number; reviewTime: number; lines: number }
    >();
    let latestEventTime = 0;

    for (const event of events) {
      if (!event.filePath) {
        continue;
      }

      const isExempt = this.isExemptFile(event.filePath, policy);
      const lines =
        event.linesChanged ??
        (event.linesOfCode ?? 0) + (event.linesRemoved ?? 0);
      const isManual =
        event.source === CodeSource.Manual ||
        event.detectionMethod === "manual" ||
        event.detectionMethod === "manual-typing";
      // Editor-assisted edits (deletions, undo/redo, Emmet, cut-and-paste
      // refactoring) are neither AI nor manual authorship. They are excluded
      // from the line totals, matching the dashboard (MetricsRepository skips
      // CodeSource.Neutral). Counting them as manual would let a student lower
      // their AI percentage by repeatedly deleting and undoing AI code.
      const isNeutral =
        !isManual &&
        (event.source === CodeSource.Neutral ||
          (event.detectionMethod !== undefined &&
            NON_AI_DETECTION_METHODS.has(event.detectionMethod)));

      if (isExempt) {
        continue;
      }

      latestEventTime = Math.max(latestEventTime, event.timestamp);

      if (isNeutral) {
        continue;
      }

      if (isManual) {
        manualLines += lines;
        totalLines += lines;
        continue;
      }

      // Re-classify if not already classified ( defensive )
      const classification =
        event.aiClassification ??
        this.classifyEvent(event, policy).classification;
      const violationType =
        event.policyViolation ??
        this.classifyEvent(event, policy).violationType;

      switch (classification) {
        case AIClassification.Permitted:
          permittedAILines += lines;
          break;
        case AIClassification.Prohibited:
          prohibitedAILines += lines;
          break;
        case AIClassification.Flag:
          flaggedAILines += lines;
          break;
      }
      totalLines += lines;

      if (violationType === PolicyViolationType.AgenticUse) {
        addViolation(
          PolicyViolationType.AgenticUse,
          "high",
          "Agentic AI use detected (files modified by an external agent or AI commit markers)",
          {
            filePath: event.filePath,
            detectionMethod: event.detectionMethod,
            lines: event.linesOfCode ?? 0,
            tool: event.tool,
          },
          event.timestamp,
        );
      }

      // Track file review state for ownership
      if (
        classification !== AIClassification.Permitted ||
        event.detectionMethod === AIDetectionMethod.LargePaste
      ) {
        const key = `${event.filePath}:${event.tool}`;
        const existing = aiFiles.get(key) || {
          reviewScore: 0,
          reviewTime: 0,
          lines: 0,
        };
        existing.lines += lines;
        aiFiles.set(key, existing);
      }

      // Detect unreviewed large paste
      if (event.detectionMethod === AIDetectionMethod.LargePaste) {
        const reviewTime = event.acceptanceTimeDelta ?? 0;
        if (reviewTime < policy.minLargePasteReviewTimeMs) {
          addViolation(
            PolicyViolationType.UnreviewedLargePaste,
            "medium",
            `Large paste accepted after only ${reviewTime}ms (minimum ${policy.minLargePasteReviewTimeMs}ms)`,
            {
              filePath: event.filePath,
              reviewTimeMs: reviewTime,
              lines: event.linesOfCode ?? 0,
              characters: event.charactersCount ?? 0,
            },
            event.timestamp,
          );
        }
      }
    }

    // Merge file reviews for ownership calculation
    for (const review of fileReviews) {
      const key = `${review.filePath}:${review.tool}`;
      const entry = aiFiles.get(key);
      if (entry) {
        entry.reviewScore = review.reviewScore ?? 0;
        entry.reviewTime = review.totalReviewTime ?? 0;
      }
    }

    let totalReviewScore = 0;
    let filesWithReview = 0;
    let filesUnreviewed = 0;
    let unreviewedLines = 0;
    let totalReviewTime = 0;

    for (const [, entry] of aiFiles.entries()) {
      if (entry.reviewScore > 0 || entry.reviewTime > 0) {
        totalReviewScore += entry.reviewScore;
        totalReviewTime += entry.reviewTime;
        filesWithReview++;
      } else {
        filesUnreviewed++;
        unreviewedLines += entry.lines;
      }
    }

    const ownershipScore =
      filesWithReview > 0 ? totalReviewScore / filesWithReview : 0;

    const authorship: AssignmentAuthorship = {
      totalLines,
      manualLines,
      permittedAILines,
      prohibitedAILines,
      flaggedAILines,
      authorshipPercentage:
        totalLines > 0
          ? ((permittedAILines + prohibitedAILines + flaggedAILines) /
              totalLines) *
            100
          : 0,
      prohibitedPercentage:
        totalLines > 0 ? (prohibitedAILines / totalLines) * 100 : 0,
    };

    const ownership: AssignmentOwnership = {
      score: ownershipScore,
      filesReviewed: filesWithReview,
      filesUnreviewed: filesUnreviewed,
      unreviewedLines,
      averageReviewTimeMs:
        filesWithReview > 0 ? totalReviewTime / filesWithReview : 0,
    };

    // Authorship threshold violation
    if (authorship.authorshipPercentage > policy.maxAuthorshipPercentage) {
      addViolation(
        PolicyViolationType.AuthorshipExceeded,
        "medium",
        `AI authorship ${authorship.authorshipPercentage.toFixed(1)}% exceeds limit of ${policy.maxAuthorshipPercentage}%`,
        {
          actualPercentage: authorship.authorshipPercentage,
          maxAllowedPercentage: policy.maxAuthorshipPercentage,
          aiLines: permittedAILines + prohibitedAILines + flaggedAILines,
        },
        latestEventTime,
      );
    }

    // Ownership threshold violation
    if (
      ownershipScore < policy.minOwnershipScore &&
      filesWithReview + filesUnreviewed > 0
    ) {
      addViolation(
        PolicyViolationType.OwnershipBelowMinimum,
        "medium",
        `Ownership score ${ownershipScore.toFixed(1)} is below minimum ${policy.minOwnershipScore}`,
        {
          actualScore: ownershipScore,
          minAllowedScore: policy.minOwnershipScore,
          filesUnreviewed,
        },
        latestEventTime,
      );
    }

    // Tracking gaps. The leading gap is measured from when the assignment
    // existed (createdAt), not the calendar-day boundary of startDate —
    // otherwise time before the assignment existed is flagged as "no tracking".
    const trackingGaps = this.detectTrackingGaps(
      events,
      assignment.startDate,
      assignment.endDate,
      gapThresholdMs,
      assignment.createdAt,
    );
    for (const gap of trackingGaps) {
      addViolation(
        PolicyViolationType.TrackingGap,
        "low",
        `No tracking activity for ${gap.durationSeconds} seconds during assignment window`,
        {
          startTime: gap.startTime,
          endTime: gap.endTime,
          durationSeconds: gap.durationSeconds,
        },
        gap.endTime,
      );
    }

    return {
      assignmentId: assignment.id,
      authorship,
      ownership,
      violations: Array.from(violationMap.values()),
      rawEvents: events,
      fileReviews,
      trackingGaps,
    };
  }

  /**
   * Detect long periods without tracked events inside the assignment window.
   */
  detectTrackingGaps(
    events: TrackingEvent[],
    startDate: string,
    endDate: string,
    thresholdMs: number,
    notBeforeMs?: number,
  ): TrackingGap[] {
    const gaps: TrackingGap[] = [];
    // Local day boundaries - must match DatabaseManager.getEventsForAssignment
    // and MetricsRepository.calculateDailyMetrics, or the report and the
    // dashboard disagree about which events belong to the assignment.
    const startTime = Math.max(
      startOfLocalDay(startDate),
      notBeforeMs ?? 0,
    );
    const endTime = startOfLocalDay(addDays(endDate, 1)); // Include full end day
    const now = Date.now();

    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

    // Gap from start of assignment to first event
    if (sorted.length > 0) {
      const firstEvent = sorted[0].timestamp;
      if (firstEvent - startTime > thresholdMs) {
        gaps.push({
          startTime,
          endTime: firstEvent,
          durationSeconds: Math.floor((firstEvent - startTime) / 1000),
        });
      }
    }

    // Gaps between consecutive events
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].timestamp;
      const curr = sorted[i].timestamp;
      if (curr - prev > thresholdMs) {
        gaps.push({
          startTime: prev,
          endTime: curr,
          durationSeconds: Math.floor((curr - prev) / 1000),
        });
      }
    }

    // Gap from last event to now (if still within assignment window)
    if (sorted.length > 0 && now < endTime) {
      const lastEvent = sorted[sorted.length - 1].timestamp;
      if (now - lastEvent > thresholdMs) {
        gaps.push({
          startTime: lastEvent,
          endTime: now,
          durationSeconds: Math.floor((now - lastEvent) / 1000),
        });
      }
    }

    return gaps;
  }

  private isExemptFile(filePath: string, policy: AssignmentPolicy): boolean {
    return matchesAnyGlob(filePath, policy.exemptFileGlobs);
  }
}
