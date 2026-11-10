/**
 * DatabaseManager path anonymization tests (real database).
 *
 * Verifies the two properties that matter:
 *  1. What lands in the DB has no username / absolute machine layout.
 *  2. What comes back out is the original absolute path, so runtime logic
 *     (cache keys, "open file for review", UNIQUE(file_path,date,tool))
 *     keeps working unchanged.
 */

import * as fs from "fs";
import * as path from "path";
import { DatabaseManager } from "../DatabaseManager";
import {
  TrackingEvent,
  FileReviewStatus,
  AITool,
  EventType,
  CodeSource,
  ReviewQuality,
} from "../../types";

describe("DatabaseManager path anonymization", () => {
  let dbManager: DatabaseManager;
  let tempDir: string;

  const workspace = path.resolve(__dirname, "..", "..", "..", "test-data", "anon-workspace").replace(/\\/g, "/");
  const today = new Date().toISOString().split("T")[0];
  const p = (...parts: string[]) => path.join(...parts).replace(/\\/g, "/");

  const event = (filePath: string): TrackingEvent => ({
    timestamp: Date.now(),
    tool: AITool.ClaudeCode,
    source: CodeSource.AI,
    eventType: EventType.CodeGenerated,
    linesOfCode: 5,
    filePath,
    language: "typescript",
  });

  const review = (filePath: string): FileReviewStatus => ({
    filePath,
    date: today,
    tool: AITool.ClaudeCode,
    reviewQuality: ReviewQuality.None,
    reviewScore: 0,
    isReviewed: false,
    linesGenerated: 5,
    linesChanged: 5,
    linesSinceReview: 5,
    charactersCount: 200,
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
  });

  beforeEach(async () => {
    tempDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "test-data",
      `anon-test-${Date.now()}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
    dbManager = new DatabaseManager(tempDir, workspace);
    await dbManager.initialize();
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stores event paths workspace-relative, not absolute", async () => {
    await dbManager.insertEvent(event(path.join(workspace, "src", "auth", "login.ts")));

    const stored = await dbManager.getAllEventPaths();
    expect(stored[0].file_path).toBe("src/auth/login.ts");
    expect(stored[0].file_path).not.toContain("testuser");
  });

  it("returns absolute paths when reading events back", async () => {
    const abs = path.join(workspace, "src", "auth", "login.ts");
    await dbManager.insertEvent(event(abs));

    const events = await dbManager.getRecentEvents(10);
    expect(events[0].filePath).toBe(p(workspace, "src", "auth", "login.ts"));
  });

  it("round-trips file review status paths", async () => {
    const abs = path.join(workspace, "src", "a.ts");
    await dbManager.insertOrUpdateFileReviewStatus(review(abs));

    const stored = await dbManager.getAllFileReviewPaths();
    expect(stored[0].file_path).toBe("src/a.ts");

    const rows = await dbManager.getFileReviewsForDate(today);
    expect(rows[0].filePath).toBe(p(workspace, "src", "a.ts"));
  });

  it("file review upsert still matches its existing row (no duplicate)", async () => {
    const abs = path.join(workspace, "src", "a.ts");
    await dbManager.insertOrUpdateFileReviewStatus(review(abs));

    // Second write with the same absolute path must UPDATE, not INSERT a
    // second row. This is why the SELECT lookup uses the anonymized form.
    const second = { ...review(abs), linesGenerated: 12 };
    await dbManager.insertOrUpdateFileReviewStatus(second);

    const rows = await dbManager.getFileReviewsForDate(today);
    expect(rows).toHaveLength(1);
    expect(rows[0].linesGenerated).toBe(12);
  });

  it("markFileAsReviewed updates the anonymized row", async () => {
    const abs = path.join(workspace, "src", "a.ts");
    await dbManager.insertOrUpdateFileReviewStatus(review(abs));

    await dbManager.markFileAsReviewed(abs, AITool.ClaudeCode, today, "mid", "manual", 8000);

    const rows = await dbManager.getFileReviewsForDate(today);
    expect(rows[0].isReviewed).toBe(true);
    expect(rows[0].totalReviewTime).toBe(8000);
  });

  it("stores absolute paths when anonymization is disabled", async () => {
    dbManager.setAnonymizePaths(false);
    const abs = path.join(workspace, "src", "a.ts");
    await dbManager.insertEvent(event(abs));

    const stored = await dbManager.getAllEventPaths();
    // when disabled, path stored as-is
    expect((stored[0].file_path || "").replace(/\\/g, "/")).toBe(p(workspace, "src", "a.ts"));

    // Reads still work
    const events = await dbManager.getRecentEvents(10);
    expect((events[0].filePath || "").replace(/\\/g, "/")).toBe(p(workspace, "src", "a.ts"));
  });

  it("migrates pre-existing absolute paths and reports the count", async () => {
    // Simulate legacy rows written before anonymization existed: insert with
    // the setting off, so the raw absolute path lands in the table.
    dbManager.setAnonymizePaths(false);
    await dbManager.insertEvent(event(path.join(workspace, "src", "legacy.ts")));
    await dbManager.insertEvent(event(path.join(workspace, "src", "legacy2.ts")));

    const before = await dbManager.getAllEventPaths();
    expect(before.every((r) => path.isAbsolute(r.file_path!) || /^[a-zA-Z]:\//.test(r.file_path!))).toBe(true);

    dbManager.setAnonymizePaths(true);
    const result = dbManager.migrateAnonymizeExistingPaths();
    expect(result.events).toBe(2);

    const after = await dbManager.getAllEventPaths();
    expect(after.map((r) => r.file_path).sort()).toEqual([
      "src/legacy.ts",
      "src/legacy2.ts",
    ]);

    // And reads still resolve to absolute (posix-normalized by anonymizer)
    const events = await dbManager.getRecentEvents(10);
    expect(events.every((e) => e.filePath!.startsWith(workspace))).toBe(true);
  });

  it("migration is idempotent", async () => {
    dbManager.setAnonymizePaths(false);
    await dbManager.insertEvent(event(path.join(workspace, "src", "a.ts")));
    dbManager.setAnonymizePaths(true);

    expect(dbManager.migrateAnonymizeExistingPaths().events).toBe(1);
    expect(dbManager.migrateAnonymizeExistingPaths().events).toBe(0);
  });

  it("migration is a no-op when disabled", async () => {
    await dbManager.insertEvent(event(path.join(workspace, "src", "a.ts")));
    dbManager.setAnonymizePaths(false);
    expect(dbManager.migrateAnonymizeExistingPaths().events).toBe(0);
  });
});
