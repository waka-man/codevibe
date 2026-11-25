/**
 * Excluded-path purge + exclusion audit tests (real database).
 *
 * Covers: DatabaseManager delete/scan helpers and
 * MetricsRepository.purgeExcludedEvents end-to-end (delete + metrics recalc).
 */

import * as fs from "fs";
import * as path from "path";
import { DatabaseManager } from "../DatabaseManager";
import { MetricsRepository } from "../MetricsRepository";
import {
  TrackingEvent,
  FileReviewStatus,
  Assignment,
  AITool,
  EventType,
  CodeSource,
  ReviewQuality,
} from "../../types";
import {
  clearGeneratedOutputs,
  registerGeneratedOutput,
} from "../../utils/GeneratedOutputGuard";

describe("Excluded-path purge", () => {
  let dbManager: DatabaseManager;
  let metricsRepo: MetricsRepository;
  let tempDir: string;

  const today = new Date().toISOString().split("T")[0];

  function makeEvent(filePath: string, lines: number): TrackingEvent {
    return {
      timestamp: Date.now(),
      tool: AITool.ClaudeCode,
      source: CodeSource.AI,
      eventType: EventType.CodeGenerated,
      linesOfCode: lines,
      linesChanged: lines,
      charactersCount: lines * 40,
      filePath,
      language: "typescript",
      detectionMethod: "external-file-change",
      confidence: "high",
    };
  }

  function makeReview(filePath: string, lines: number): FileReviewStatus {
    return {
      filePath,
      date: today,
      tool: AITool.ClaudeCode,
      reviewQuality: ReviewQuality.None,
      reviewScore: 0,
      isReviewed: false,
      linesGenerated: lines,
      linesChanged: lines,
      linesSinceReview: lines,
      charactersCount: lines * 40,
      isAgentGenerated: true,
      wasFileOpen: false,
      firstGeneratedAt: Date.now(),
      totalReviewTime: 0,
      modificationCount: 1,
      totalTimeInFocus: 0,
      scrollEventCount: 0,
      cursorMovementCount: 0,
      editsMade: false,
      reviewSessionsCount: 0,
      reviewedInTerminal: false,
    };
  }

  beforeEach(async () => {
    clearGeneratedOutputs();
    tempDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "test-data",
      `purge-test-${Date.now()}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
    dbManager = new DatabaseManager(tempDir);
    await dbManager.initialize();
    metricsRepo = new MetricsRepository(dbManager);
  });

  afterEach(() => {
    clearGeneratedOutputs();
    dbManager.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes node_modules/venv events and reviews, keeps source files", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/node_modules/lodash/lodash.js", 1000),
    );
    await dbManager.insertEvent(
      makeEvent("/proj/.venv/lib/site-packages/numpy/core.py", 500),
    );
    await dbManager.insertEvent(makeEvent("/proj/package-lock.json", 800));
    await dbManager.insertEvent(makeEvent("/proj/src/app.ts", 10));
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/node_modules/lodash/lodash.js", 1000),
    );
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/src/app.ts", 10),
    );

    const result = await metricsRepo.purgeExcludedEvents();

    expect(result.eventsDeleted).toBe(3);
    expect(result.fileReviewsDeleted).toBe(1);
    expect(result.datesRecalculated).toContain(today);

    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/app.ts"]);

    const reviews = await dbManager.getFileReviewsForDate(today);
    expect(reviews.map((r) => r.filePath)).toEqual(["/proj/src/app.ts"]);
  });

  it("runtime output registrations block new writes but never authorize historical purges", async () => {
    const outputPath = "/proj/submission/evidence.json";
    await dbManager.insertEvent(makeEvent(outputPath, 500));
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview(outputPath, 500),
    );
    registerGeneratedOutput(outputPath);

    expect(await metricsRepo.recordEvent(makeEvent(outputPath, 5))).toBe(0);
    await metricsRepo.saveFileReviewStatus(makeReview(outputPath, 5));

    const result = await metricsRepo.purgeExcludedEvents();

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
    expect(await dbManager.getRecentEvents(100)).toHaveLength(1);
    expect(await dbManager.getFileReviewsForDate(today)).toHaveLength(1);
    expect(await metricsRepo.getUnreviewedFiles(today)).toHaveLength(1);
  });

  it("does not touch lookalike paths", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/my-node_modules-backup/app.ts", 7),
    );

    const result = await metricsRepo.purgeExcludedEvents();

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
  });

  it("is idempotent (second run deletes nothing)", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/node_modules/pkg/index.js", 100),
    );

    const first = await metricsRepo.purgeExcludedEvents();
    expect(first.eventsDeleted).toBe(1);

    const second = await metricsRepo.purgeExcludedEvents();
    expect(second.eventsDeleted).toBe(0);
    expect(second.fileReviewsDeleted).toBe(0);
  });

  it("honours extra user globs", async () => {
    await dbManager.insertEvent(makeEvent("/proj/generated/types.ts", 50));
    await dbManager.insertEvent(makeEvent("/proj/src/app.ts", 10));

    const result = await metricsRepo.purgeExcludedEvents(["**/generated/**"]);

    expect(result.eventsDeleted).toBe(1);
    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/app.ts"]);
  });

  it("user globs never purge events that belong to an assignment", async () => {
    await dbManager.insertEvent({
      ...makeEvent("/proj/src/graded.ts", 40),
      assignmentId: "assignment-1",
    });
    await dbManager.insertEvent({
      ...makeEvent("/proj/node_modules/pkg/index.js", 100),
      assignmentId: "assignment-1",
    });
    await dbManager.insertEvent(makeEvent("/proj/src/scratch.ts", 5));

    const result = await metricsRepo.purgeExcludedEvents(["src/**"], {
      preserveAssignmentEvents: true,
    });

    // scratch.ts (no assignment) and the built-in node_modules row go;
    // the assignment's source event stays as evidence.
    expect(result.eventsDeleted).toBe(2);
    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/graded.ts"]);
  });

  it("preserves untagged assignment-window events and their reviews from user globs", async () => {
    const assignment: Assignment = {
      id: "assignment-window-1",
      name: "Windowed assignment",
      startDate: today,
      endDate: today,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      isActive: false,
      policy: {} as Assignment["policy"],
    };
    await dbManager.insertOrUpdateAssignment(assignment);
    await dbManager.insertEvent(makeEvent("/proj/src/graded.ts", 40));
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/src/graded.ts", 40),
    );

    const result = await metricsRepo.purgeExcludedEvents(["src/**"], {
      preserveAssignmentEvents: true,
    });

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/graded.ts"]);
    const reviews = await dbManager.getFileReviewsForDate(today);
    expect(reviews.map((review) => review.filePath)).toEqual([
      "/proj/src/graded.ts",
    ]);
  });

  it("preserves reviews for tagged assignment events outside the date window", async () => {
    const oldDate = "2020-01-01";
    await dbManager.insertEvent({
      ...makeEvent("/proj/src/graded.ts", 40),
      assignmentId: "assignment-outside-window",
      timestamp: new Date(`${oldDate}T12:00:00Z`).getTime(),
    });
    await dbManager.insertOrUpdateFileReviewStatus({
      ...makeReview("/proj/src/graded.ts", 40),
      date: oldDate,
    });

    const result = await metricsRepo.purgeExcludedEvents(["src/**"], {
      preserveAssignmentEvents: true,
    });

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
    expect(await dbManager.getRecentEvents(100)).toHaveLength(1);
    expect(await dbManager.getFileReviewsForDate(oldDate)).toHaveLength(1);
  });

  it("cancels a queued purge before deleting when exclusions change", async () => {
    await dbManager.insertEvent(makeEvent("/proj/src/scratch.ts", 5));

    const result = await metricsRepo.purgeExcludedEvents(["src/**"], {
      isCancelled: () => true,
    });

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
    expect(await dbManager.getRecentEvents(100)).toHaveLength(1);
  });

  it("never stores or lists excluded paths via the repository (#37)", async () => {
    const pnpmFile = "/proj/node_modules/.pnpm/vite@5/node_modules/vite/bin/vite.js";
    await metricsRepo.recordEvent(makeEvent(pnpmFile, 90));
    await metricsRepo.saveFileReviewStatus(makeReview(pnpmFile, 90));
    // A row written before the guard existed must still not be listed
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/.svelte-kit/generated/root.js", 30),
    );
    await metricsRepo.saveFileReviewStatus(makeReview("/proj/src/app.ts", 10));

    expect(await dbManager.getRecentEvents(100)).toEqual([]);
    const unreviewed = await metricsRepo.getUnreviewedFiles(today);
    expect(unreviewed.map((f: any) => f.filePath)).toEqual(["/proj/src/app.ts"]);
  });

  it("does not re-store custom-excluded events or review rows", async () => {
    const eventPath = "/proj/src/generated/types.ts";
    const reviewPath = "/proj/src/generated/review.ts";

    expect(
      await metricsRepo.recordEvent(makeEvent(eventPath, 20), [
        "src/generated/**",
      ]),
    ).toBe(0);
    await metricsRepo.saveFileReviewStatus(makeReview(reviewPath, 20), [
      "src/generated/**",
    ]);

    expect(await dbManager.getRecentEvents(100)).toEqual([]);
    expect(await dbManager.getFileReviewsForDate(today)).toEqual([]);
  });

  it("records and retrieves the exclusion audit trail", async () => {
    const now = Date.now();
    await dbManager.recordExclusionAudit(now, ["**/src/**"], "settings");
    await dbManager.recordExclusionAudit(now + 1, [], "assignment-activated");

    const entries = await dbManager.getExclusionAudit(now - 1000, now + 1000);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      globs: ["**/src/**"],
      source: "settings",
    });
    expect(entries[1].source).toBe("assignment-activated");
  });
});
