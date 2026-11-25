/**
 * PolicyEngine Unit Tests
 *
 * Verifies that authorship/ownership numbers are computed exactly as specified
 * for deterministic fixture events. These numbers are what ends up in the
 * exported AssignmentReport, so they must be stable and correct.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { PolicyEngine } from "../PolicyEngine";
import {
  clearGeneratedOutputs,
  registerGeneratedOutput,
} from "../../utils/GeneratedOutputGuard";
import {
  AIDetectionMethod,
  AIClassification,
  AITool,
  Assignment,
  AssignmentPolicy,
  CodeSource,
  EventType,
  PolicyViolationType,
  TrackingEvent,
} from "../../types";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;
  let policy: AssignmentPolicy;

  // Fixed assignment window in the past so tracking-gap detection is deterministic
  // (the "last event -> now" trailing gap never fires for past end dates).
  const assignment: Assignment = {
    id: "asgn-test-1",
    name: "HW1 - Linked Lists",
    courseId: "CS101",
    startDate: "2025-01-02",
    endDate: "2025-01-09",
    policy: undefined as unknown as AssignmentPolicy, // replaced in beforeEach
    createdAt: new Date("2025-01-01T00:00:00Z").getTime(),
    updatedAt: new Date("2025-01-01T00:00:00Z").getTime(),
    isActive: true,
  };

  beforeEach(() => {
    clearGeneratedOutputs();
    engine = new PolicyEngine();
    policy = {
      maxAuthorshipPercentage: 30,
      minOwnershipScore: 40,
      exemptFileGlobs: ["**/*.md", "**/package.json"],
      prohibitedMethods: [
        AIDetectionMethod.ExternalFileChange,
        AIDetectionMethod.GitCommitMarker,
      ],
      permittedMethods: [AIDetectionMethod.InlineCompletionAPI],
      flaggedMethods: [
        AIDetectionMethod.LargePaste,
        AIDetectionMethod.ChangeVelocity,
      ],
      minLargePasteReviewTimeMs: 5000,
      // Large enough that fixture events never trigger tracking gaps
      // unless a test explicitly asks for them.
      maxTrackingGapSeconds: 999999999,
    };
    assignment.policy = policy;
  });

  const ts = (iso: string) => new Date(iso).getTime();

  function aiEvent(overrides: Partial<TrackingEvent>): TrackingEvent {
    return {
      timestamp: ts("2025-01-02T09:00:00Z"),
      tool: AITool.Cursor,
      eventType: EventType.SuggestionAccepted,
      source: CodeSource.AI,
      ...overrides,
    };
  }

  function manualEvent(overrides: Partial<TrackingEvent>): TrackingEvent {
    return {
      timestamp: ts("2025-01-02T09:00:00Z"),
      tool: AITool.Copilot,
      eventType: EventType.SuggestionAccepted,
      source: CodeSource.Manual,
      ...overrides,
    };
  }

  describe("classifyEvent", () => {
    it("classifies prohibited methods as Prohibited with AgenticUse violation", () => {
      const event = aiEvent({
        detectionMethod: AIDetectionMethod.ExternalFileChange,
      });
      const result = engine.classifyEvent(event, policy);
      expect(result.classification).toBe(AIClassification.Prohibited);
      expect(result.violationType).toBe(PolicyViolationType.AgenticUse);
    });

    it("classifies permitted methods as Permitted without violation", () => {
      const event = aiEvent({
        detectionMethod: AIDetectionMethod.InlineCompletionAPI,
      });
      const result = engine.classifyEvent(event, policy);
      expect(result.classification).toBe(AIClassification.Permitted);
      expect(result.violationType).toBeUndefined();
    });

    it("classifies flagged methods as Flag without violation", () => {
      const event = aiEvent({ detectionMethod: AIDetectionMethod.LargePaste });
      const result = engine.classifyEvent(event, policy);
      expect(result.classification).toBe(AIClassification.Flag);
      expect(result.violationType).toBeUndefined();
    });

    it("classifies uncategorized methods as Flag", () => {
      const event = aiEvent({ detectionMethod: "some-future-method" });
      expect(engine.classifyEvent(event, policy).classification).toBe(
        AIClassification.Flag,
      );
    });

    it("classifies events without detection method as Permitted", () => {
      const event = aiEvent({ detectionMethod: undefined });
      expect(engine.classifyEvent(event, policy).classification).toBe(
        AIClassification.Permitted,
      );
    });

    it.each([
      "manual-typing",
      "manual-deletion",
      "editor-undo-redo",
      "editor-assisted-change",
      "editor-refactoring",
    ])("classifies %s as Permitted (manual edit, not AI-authored)", (method) => {
      const event = aiEvent({
        source: CodeSource.Neutral,
        detectionMethod: method,
      });
      const result = engine.classifyEvent(event, policy);
      expect(result.classification).toBe(AIClassification.Permitted);
      expect(result.violationType).toBeUndefined();
    });
  });

  describe("computeMetrics - authorship numbers", () => {
    it("computes exact line counts and percentages for a mixed fixture", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 100 }),
        aiEvent({
          filePath: "/repo/src/b.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesOfCode: 50,
        }),
        aiEvent({
          filePath: "/repo/src/c.ts",
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 30,
        }),
        aiEvent({
          filePath: "/repo/src/d.ts",
          detectionMethod: AIDetectionMethod.LargePaste,
          linesOfCode: 20,
          acceptanceTimeDelta: 10000, // above 5000ms minimum -> no paste violation
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.assignmentId).toBe("asgn-test-1");
      expect(metrics.authorship.totalLines).toBe(200);
      expect(metrics.authorship.manualLines).toBe(100);
      expect(metrics.authorship.permittedAILines).toBe(50);
      expect(metrics.authorship.prohibitedAILines).toBe(30);
      expect(metrics.authorship.flaggedAILines).toBe(20);
      // (50 + 30 + 20) / 200 = 50%
      expect(metrics.authorship.authorshipPercentage).toBeCloseTo(50, 5);
      // 30 / 200 = 15%
      expect(metrics.authorship.prohibitedPercentage).toBeCloseTo(15, 5);
    });

    it("excludes exempt files (globs) from all authorship counts", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 100 }),
        manualEvent({ filePath: "/repo/README.md", linesChanged: 1000 }),
        aiEvent({
          filePath: "/repo/docs/notes.md",
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 500,
        }),
        aiEvent({
          filePath: "/repo/package.json",
          detectionMethod: AIDetectionMethod.GitCommitMarker,
          linesOfCode: 5,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.totalLines).toBe(100);
      expect(metrics.authorship.manualLines).toBe(100);
      expect(metrics.authorship.prohibitedAILines).toBe(0);
      expect(metrics.authorship.authorshipPercentage).toBe(0);
    });

    it("keeps pre-existing evidence when a path is later registered as export output", () => {
      const outputPath = "/repo/submission/evidence.json";
      registerGeneratedOutput(outputPath);
      const events: TrackingEvent[] = [
        aiEvent({
          filePath: outputPath,
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 500,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.totalLines).toBe(500);
      expect(metrics.authorship.prohibitedAILines).toBe(500);
    });

    it("skips events without a file path", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 10 }),
        aiEvent({
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 999,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.totalLines).toBe(10);
      expect(metrics.authorship.prohibitedAILines).toBe(0);
    });

    it("prefers linesChanged over linesOfCode + linesRemoved, with fallback", () => {
      const events: TrackingEvent[] = [
        // linesChanged wins when present
        aiEvent({
          filePath: "/repo/a.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesChanged: 7,
          linesOfCode: 100,
          linesRemoved: 100,
        }),
        // fallback: added + removed
        aiEvent({
          filePath: "/repo/b.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesOfCode: 10,
          linesRemoved: 5,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.permittedAILines).toBe(22); // 7 + (10 + 5)
      expect(metrics.authorship.totalLines).toBe(22);
    });

    it('treats detectionMethod "manual" as manual even without source field', () => {
      const events: TrackingEvent[] = [
        {
          timestamp: ts("2025-01-02T09:00:00Z"),
          tool: AITool.Copilot,
          eventType: EventType.SuggestionAccepted,
          filePath: "/repo/src/a.ts",
          detectionMethod: "manual",
          linesChanged: 42,
        },
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.manualLines).toBe(42);
      expect(metrics.authorship.authorshipPercentage).toBe(0);
    });

    it("respects pre-set aiClassification on events (no defensive re-classification)", () => {
      // Event detected via a permitted method but stored as prohibited
      // (e.g. classified earlier by a stricter policy) must count as prohibited.
      const events: TrackingEvent[] = [
        aiEvent({
          filePath: "/repo/src/a.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          aiClassification: AIClassification.Prohibited,
          linesOfCode: 30,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.prohibitedAILines).toBe(30);
      expect(metrics.authorship.permittedAILines).toBe(0);
    });

    it("returns zeros (no NaN) when there are no countable events", () => {
      const metrics = engine.computeMetrics(assignment, [], []);

      expect(metrics.authorship.totalLines).toBe(0);
      expect(metrics.authorship.authorshipPercentage).toBe(0);
      expect(metrics.authorship.prohibitedPercentage).toBe(0);
      expect(metrics.ownership.score).toBe(100);
      expect(metrics.violations).toHaveLength(0);
    });

    it("flags AuthorshipExceeded when AI percentage crosses the policy limit", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 50 }),
        aiEvent({
          filePath: "/repo/src/b.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesOfCode: 50,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.authorshipPercentage).toBeCloseTo(50, 5);
      const violation = metrics.violations.find(
        (v) => v.type === PolicyViolationType.AuthorshipExceeded,
      );
      expect(violation).toBeDefined();
      expect(violation!.details.actualPercentage).toBeCloseTo(50, 5);
      expect(violation!.details.maxAllowedPercentage).toBe(30);
      expect(violation!.details.aiLines).toBe(50);
    });

    it("does not flag AuthorshipExceeded exactly at the limit", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 70 }),
        aiEvent({
          filePath: "/repo/src/b.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesOfCode: 30,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.authorshipPercentage).toBeCloseTo(30, 5);
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.AuthorshipExceeded,
        ),
      ).toBeUndefined();
    });
  });

  describe("computeMetrics - ownership numbers", () => {
    const prohibitedEvent = () =>
      aiEvent({
        filePath: "/repo/src/c.ts",
        detectionMethod: AIDetectionMethod.ExternalFileChange,
        linesOfCode: 30,
      });
    const pasteEvent = () =>
      aiEvent({
        filePath: "/repo/src/d.ts",
        detectionMethod: AIDetectionMethod.LargePaste,
        linesOfCode: 20,
        acceptanceTimeDelta: 10000,
      });

    it("merges file reviews by filePath:tool and computes exact ownership stats", () => {
      const events = [prohibitedEvent(), pasteEvent()];
      const fileReviews = [
        {
          filePath: "/repo/src/c.ts",
          tool: AITool.Cursor,
          reviewScore: 80,
          totalReviewTime: 4000,
        },
      ];

      const metrics = engine.computeMetrics(assignment, events, fileReviews);

      expect(metrics.ownership.score).toBeCloseTo(80, 5); // avg over reviewed files only
      expect(metrics.ownership.filesReviewed).toBe(1);
      expect(metrics.ownership.filesUnreviewed).toBe(1);
      expect(metrics.ownership.unreviewedLines).toBe(20); // d.ts paste lines
      expect(metrics.ownership.averageReviewTimeMs).toBeCloseTo(4000, 5);
    });

    it("averages review-quality scores when every flagged file has been reviewed", () => {
      const events = [prohibitedEvent(), pasteEvent()];
      const fileReviews = [
        {
          filePath: "/repo/src/c.ts",
          tool: AITool.Cursor,
          reviewScore: 60,
          totalReviewTime: 2000,
        },
        {
          filePath: "/repo/src/d.ts",
          tool: AITool.Cursor,
          reviewScore: 90,
          totalReviewTime: 6000,
        },
      ];

      const metrics = engine.computeMetrics(assignment, events, fileReviews);

      expect(metrics.ownership.score).toBeCloseTo(75, 5); // (60 + 90) / 2
      expect(metrics.ownership.filesReviewed).toBe(2);
      expect(metrics.ownership.filesUnreviewed).toBe(0);
      expect(metrics.ownership.unreviewedLines).toBe(0);
      expect(metrics.ownership.averageReviewTimeMs).toBeCloseTo(4000, 5); // (2000 + 6000) / 2
    });

    it("still flags low review quality when every flagged file has been reviewed", () => {
      const events = [prohibitedEvent(), pasteEvent()];
      const fileReviews = events.map((event) => ({
        filePath: event.filePath,
        tool: event.tool,
        reviewScore: 10,
        totalReviewTime: 1000,
      }));

      const metrics = engine.computeMetrics(assignment, events, fileReviews);

      expect(metrics.ownership.score).toBe(10);
      expect(metrics.ownership.filesUnreviewed).toBe(0);
      const violation = metrics.violations.find(
        (v) => v.type === PolicyViolationType.OwnershipBelowMinimum,
      );
      expect(violation).toBeDefined();
      expect(violation!.details.actualScore).toBe(10);
    });

    it("does not match reviews recorded under a different tool", () => {
      const events = [prohibitedEvent()];
      const fileReviews = [
        {
          filePath: "/repo/src/c.ts",
          tool: AITool.Copilot,
          reviewScore: 100,
          totalReviewTime: 9000,
        },
      ];

      const metrics = engine.computeMetrics(assignment, events, fileReviews);

      expect(metrics.ownership.filesReviewed).toBe(0);
      expect(metrics.ownership.filesUnreviewed).toBe(1);
      expect(metrics.ownership.score).toBe(0);
    });

    it("excludes permitted inline-completion files from the ownership set", () => {
      const events = [
        aiEvent({
          filePath: "/repo/src/b.ts",
          detectionMethod: AIDetectionMethod.InlineCompletionAPI,
          linesOfCode: 50,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(
        metrics.ownership.filesReviewed + metrics.ownership.filesUnreviewed,
      ).toBe(0);
      expect(metrics.ownership.score).toBe(100);
      // ...and no OwnershipBelowMinimum violation when there are no files to review
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.OwnershipBelowMinimum,
        ),
      ).toBeUndefined();
    });

    it("flags OwnershipBelowMinimum when some AI files are unreviewed and the reviewed score is under the minimum", () => {
      const events = [
        prohibitedEvent(),
        aiEvent({
          timestamp: ts("2025-01-02T12:00:00Z"),
          filePath: "/repo/src/unreviewed.ts",
          detectionMethod: AIDetectionMethod.LargePaste,
          linesOfCode: 12,
          acceptanceTimeDelta: 10000,
        }),
      ];
      const fileReviews = [
        {
          filePath: "/repo/src/c.ts",
          tool: AITool.Cursor,
          reviewScore: 20,
          totalReviewTime: 1000,
        },
      ];

      const metrics = engine.computeMetrics(assignment, events, fileReviews);

      const violation = metrics.violations.find(
        (v) => v.type === PolicyViolationType.OwnershipBelowMinimum,
      );
      expect(violation).toBeDefined();
      expect(violation!.details.actualScore).toBeCloseTo(20, 5);
      expect(violation!.details.minAllowedScore).toBe(40);
    });

    it("flags OwnershipBelowMinimum when AI files exist but none were reviewed", () => {
      const metrics = engine.computeMetrics(
        assignment,
        [prohibitedEvent()],
        [],
      );

      expect(metrics.ownership.score).toBe(0);
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.OwnershipBelowMinimum,
        ),
      ).toBeDefined();
    });
  });

  describe("computeMetrics - violations", () => {
    it("aggregates AgenticUse violations with counts for prohibited events", () => {
      const events: TrackingEvent[] = [
        aiEvent({
          timestamp: ts("2025-01-02T11:00:00Z"),
          filePath: "/repo/src/c.ts",
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 30,
        }),
        aiEvent({
          timestamp: ts("2025-01-02T14:30:00Z"),
          filePath: "/repo/src/e.ts",
          detectionMethod: AIDetectionMethod.GitCommitMarker,
          linesOfCode: 12,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      const agentic = metrics.violations.find(
        (v) => v.type === PolicyViolationType.AgenticUse,
      );
      expect(agentic).toBeDefined();
      expect(agentic!.severity).toBe("high");
      expect(agentic!.count).toBe(2);
    });

    it("derives violation timestamps from event times, not wall clock", () => {
      // Same data -> same report hash requires deterministic timestamps.
      const events: TrackingEvent[] = [
        aiEvent({
          timestamp: ts("2025-01-02T11:00:00Z"),
          filePath: "/repo/src/c.ts",
          detectionMethod: AIDetectionMethod.ExternalFileChange,
          linesOfCode: 30,
        }),
        aiEvent({
          timestamp: ts("2025-01-02T14:30:00Z"),
          filePath: "/repo/src/e.ts",
          detectionMethod: AIDetectionMethod.GitCommitMarker,
          linesOfCode: 12,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      const agentic = metrics.violations.find(
        (v) => v.type === PolicyViolationType.AgenticUse,
      )!;
      expect(agentic.firstDetectedAt).toBe(ts("2025-01-02T11:00:00Z"));
      expect(agentic.lastDetectedAt).toBe(ts("2025-01-02T14:30:00Z"));

      // Threshold violations anchor to the latest counted event.
      const exceeded = metrics.violations.find(
        (v) => v.type === PolicyViolationType.AuthorshipExceeded,
      )!;
      expect(exceeded.firstDetectedAt).toBe(ts("2025-01-02T14:30:00Z"));

      // Recomputing from the same data yields byte-identical violations.
      const recomputed = engine.computeMetrics(assignment, events, []);
      expect(recomputed.violations).toEqual(metrics.violations);
    });

    it("does not let delete/undo cycles dilute the AI authorship percentage", () => {
      const events: TrackingEvent[] = [
        aiEvent({
          filePath: "/repo/src/a.ts",
          detectionMethod: "inline-completion-api",
          linesOfCode: 50,
          linesChanged: 50,
        }),
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 50 }),
      ];
      for (let i = 0; i < 10; i++) {
        events.push(
          aiEvent({
            source: CodeSource.Neutral,
            timestamp: ts("2025-01-02T10:00:00Z") + i * 2000,
            filePath: "/repo/src/a.ts",
            detectionMethod: "manual-deletion",
            linesOfCode: 0,
            linesChanged: 50,
          }),
          aiEvent({
            source: CodeSource.Neutral,
            timestamp: ts("2025-01-02T10:00:01Z") + i * 2000,
            filePath: "/repo/src/a.ts",
            detectionMethod: "editor-undo-redo",
            linesOfCode: 50,
            linesChanged: 50,
          }),
        );
      }

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.totalLines).toBe(100);
      expect(metrics.authorship.manualLines).toBe(50);
      expect(metrics.authorship.authorshipPercentage).toBe(50);
    });

    it("never counts cut-and-paste refactoring as AI lines", () => {
      const events: TrackingEvent[] = [
        manualEvent({ filePath: "/repo/src/a.ts", linesChanged: 20 }),
        aiEvent({
          source: CodeSource.Neutral,
          filePath: "/repo/src/b.ts",
          detectionMethod: "editor-refactoring",
          linesOfCode: 80,
          linesChanged: 80,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.authorship.flaggedAILines).toBe(0);
      expect(metrics.authorship.authorshipPercentage).toBe(0);
      expect(metrics.authorship.totalLines).toBe(20);
    });

    it("excludes editor-assisted edits from authorship totals, never counting them as AI", () => {
      const events: TrackingEvent[] = [
        manualEvent({
          filePath: "/repo/src/a.ts",
          linesChanged: 100,
        }),
        aiEvent({
          source: CodeSource.Neutral,
          timestamp: ts("2025-01-02T10:00:00Z"),
          filePath: "/repo/src/b.ts",
          detectionMethod: "manual-deletion",
          linesOfCode: 0,
          linesChanged: 40,
        }),
        aiEvent({
          source: CodeSource.Neutral,
          timestamp: ts("2025-01-02T11:00:00Z"),
          filePath: "/repo/src/b.ts",
          detectionMethod: "editor-undo-redo",
          linesOfCode: 30,
          linesChanged: 30,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      // Neutral edits are neither AI nor manual (matches the dashboard)
      expect(metrics.authorship.manualLines).toBe(100);
      expect(metrics.authorship.totalLines).toBe(100);
      expect(metrics.authorship.permittedAILines).toBe(0);
      expect(metrics.authorship.flaggedAILines).toBe(0);
      expect(metrics.authorship.authorshipPercentage).toBe(0);
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.AuthorshipExceeded,
        ),
      ).toBeUndefined();
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.OwnershipBelowMinimum,
        ),
      ).toBeUndefined();
    });

    it("flags UnreviewedLargePaste only when review time is below the minimum", () => {
      const events: TrackingEvent[] = [
        aiEvent({
          filePath: "/repo/src/d.ts",
          detectionMethod: AIDetectionMethod.LargePaste,
          linesOfCode: 20,
          acceptanceTimeDelta: 1500, // below 5000ms minimum
        }),
        aiEvent({
          filePath: "/repo/src/f.ts",
          detectionMethod: AIDetectionMethod.LargePaste,
          linesOfCode: 15,
          acceptanceTimeDelta: 8000, // fine
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      const paste = metrics.violations.find(
        (v) => v.type === PolicyViolationType.UnreviewedLargePaste,
      );
      expect(paste).toBeDefined();
      expect(paste!.severity).toBe("medium");
      expect(paste!.count).toBe(1);
      expect(paste!.details.reviewTimeMs).toBe(1500);
    });
  });

  describe("computeMetrics - tracking gaps", () => {
    it("detects gaps from assignment start and between events", () => {
      assignment.policy = { ...policy, maxTrackingGapSeconds: 1800 };
      // Local date components: the assignment window now resolves to LOCAL
      // midnight, so events must be placed against the same local clock or the
      // first-gap duration is off by the UTC offset (previously 10h, not 8h).
      const events: TrackingEvent[] = [
        manualEvent({
          timestamp: new Date(2025, 0, 2, 8, 0, 0).getTime(),
          filePath: "/repo/src/a.ts",
          linesChanged: 10,
        }),
        manualEvent({
          timestamp: new Date(2025, 0, 2, 10, 0, 0).getTime(),
          filePath: "/repo/src/a.ts",
          linesChanged: 10,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      // Gap 1: local midnight on 2025-01-02 -> first event at 08:00 = 8h = 28800s
      // Gap 2: between events = 2h = 7200s
      // No trailing gap: end date is in the past.
      expect(metrics.trackingGaps).toHaveLength(2);
      expect(metrics.trackingGaps[0].durationSeconds).toBe(28800);
      expect(metrics.trackingGaps[1].durationSeconds).toBe(7200);

      // Same-type violations aggregate into ONE PolicyViolation with count=2.
      // The per-gap source of truth is metrics.trackingGaps (asserted above).
      const gapViolations = metrics.violations.filter(
        (v) => v.type === PolicyViolationType.TrackingGap,
      );
      expect(gapViolations).toHaveLength(1);
      expect(gapViolations[0].severity).toBe("low");
      expect(gapViolations[0].count).toBe(2);
    });

    it("never starts a gap before the assignment was created", () => {
      const createdAt = new Date(2025, 0, 2, 7, 0, 0).getTime();
      const createdAssignment: Assignment = {
        ...assignment,
        createdAt,
        policy: { ...policy, maxTrackingGapSeconds: 1800 },
      };
      const events: TrackingEvent[] = [
        manualEvent({
          timestamp: new Date(2025, 0, 2, 6, 0, 0).getTime(),
          filePath: "/repo/src/a.ts",
          linesChanged: 10,
        }),
        manualEvent({
          timestamp: new Date(2025, 0, 2, 9, 0, 0).getTime(),
          filePath: "/repo/src/a.ts",
          linesChanged: 10,
        }),
      ];

      const metrics = engine.computeMetrics(createdAssignment, events, []);

      expect(metrics.trackingGaps).toHaveLength(1);
      expect(metrics.trackingGaps[0].startTime).toBe(createdAt);
      expect(metrics.trackingGaps[0].endTime).toBe(
        new Date(2025, 0, 2, 9, 0, 0).getTime(),
      );
    });

    it("records a trailing gap while the assignment window is still open", () => {
      const openAssignment: Assignment = {
        ...assignment,
        startDate: "2025-01-02",
        endDate: "2099-12-31",
        policy: { ...policy, maxTrackingGapSeconds: 1800 },
      };
      const events: TrackingEvent[] = [
        manualEvent({
          timestamp: ts("2025-01-02T00:05:00Z"),
          filePath: "/repo/src/a.ts",
          linesChanged: 10,
        }),
      ];

      const metrics = engine.computeMetrics(openAssignment, events, []);

      const trailing = metrics.trackingGaps[metrics.trackingGaps.length - 1];
      expect(trailing.startTime).toBe(ts("2025-01-02T00:05:00Z"));
      expect(trailing.endTime).toBeGreaterThan(trailing.startTime);
    });

    it("reports no gaps when events are dense relative to the threshold", () => {
      assignment.policy = { ...policy, maxTrackingGapSeconds: 999999999 };
      const events: TrackingEvent[] = [
        manualEvent({
          timestamp: ts("2025-01-02T08:00:00Z"),
          filePath: "/repo/a.ts",
          linesChanged: 1,
        }),
        manualEvent({
          timestamp: ts("2025-01-02T10:00:00Z"),
          filePath: "/repo/a.ts",
          linesChanged: 1,
        }),
      ];

      const metrics = engine.computeMetrics(assignment, events, []);

      expect(metrics.trackingGaps).toHaveLength(0);
      expect(
        metrics.violations.find(
          (v) => v.type === PolicyViolationType.TrackingGap,
        ),
      ).toBeUndefined();
    });
  });
});
