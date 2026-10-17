/**
 * AssignmentReport Generator + Integrity CLI Tests
 *
 * Covers the full export flow for one assignment:
 *   fixture events -> PolicyEngine.computeMetrics -> AssignmentReportGenerator
 *   -> JSON file -> scripts/verify-assignment-report.js (separate process)
 *
 * Also verifies the CLI rejects tampered reports (modified numbers or hash).
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PolicyEngine } from "../PolicyEngine";
import { AssignmentReportGenerator } from "../AssignmentReportGenerator";
import { writeAssignmentReport } from "../AssignmentReportFile";
import {
  AIDetectionMethod,
  AITool,
  Assignment,
  AssignmentPolicy,
  AssignmentReport,
  CodeSource,
  EventType,
  TrackingEvent,
} from "../../types";

const CLI_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "scripts",
  "verify-assignment-report.js",
);
const FIXED_GENERATED_AT = new Date("2025-01-10T12:00:00Z").getTime();

describe("AssignmentReport export + integrity", () => {
  const policy: AssignmentPolicy = {
    maxAuthorshipPercentage: 30,
    minOwnershipScore: 40,
    exemptFileGlobs: ["**/*.md"],
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
    maxTrackingGapSeconds: 999999999,
  };

  const assignment: Assignment = {
    id: "asgn-hw1-2025",
    name: "HW1 - Linked Lists",
    courseId: "CS101",
    startDate: "2025-01-02",
    endDate: "2025-01-09",
    repoUrl: "https://github.com/student/hw1",
    policy,
    createdAt: new Date("2025-01-01T00:00:00Z").getTime(),
    updatedAt: new Date("2025-01-01T00:00:00Z").getTime(),
    isActive: true,
  };

  const ts = (iso: string) => new Date(iso).getTime();

  // Deterministic fixture: 100 manual + 50 permitted + 30 prohibited + 20 flagged
  // => 200 total, 50% AI authorship, 15% prohibited.
  const fixtureEvents: TrackingEvent[] = [
    {
      timestamp: ts("2025-01-02T09:00:00Z"),
      tool: AITool.Copilot,
      eventType: EventType.SuggestionAccepted,
      source: CodeSource.Manual,
      filePath: "/repo/src/list.ts",
      linesChanged: 100,
    },
    {
      timestamp: ts("2025-01-02T10:00:00Z"),
      tool: AITool.Copilot,
      eventType: EventType.SuggestionAccepted,
      source: CodeSource.AI,
      detectionMethod: AIDetectionMethod.InlineCompletionAPI,
      filePath: "/repo/src/node.ts",
      linesOfCode: 50,
    },
    {
      timestamp: ts("2025-01-02T11:00:00Z"),
      tool: AITool.ClaudeCode,
      eventType: EventType.CodeGenerated,
      source: CodeSource.AI,
      detectionMethod: AIDetectionMethod.ExternalFileChange,
      filePath: "/repo/src/main.ts",
      linesOfCode: 30,
    },
    {
      timestamp: ts("2025-01-02T12:00:00Z"),
      tool: AITool.Cursor,
      eventType: EventType.SuggestionAccepted,
      source: CodeSource.AI,
      detectionMethod: AIDetectionMethod.LargePaste,
      filePath: "/repo/src/utils.ts",
      linesOfCode: 20,
      acceptanceTimeDelta: 10000,
    },
  ];

  const fixtureReviews = [
    {
      filePath: "/repo/src/main.ts",
      tool: AITool.ClaudeCode,
      reviewScore: 80,
      totalReviewTime: 4000,
    },
  ];

  let generator: AssignmentReportGenerator;
  let report: AssignmentReport;

  beforeEach(() => {
    generator = new AssignmentReportGenerator();
    const metrics = new PolicyEngine().computeMetrics(
      assignment,
      fixtureEvents,
      fixtureReviews,
    );
    report = generator.generate(assignment, metrics, {
      studentIdentifier: "student-042",
      repoUrl: assignment.repoUrl,
      repoHeadCommit: "abc123def456",
      generatedAt: FIXED_GENERATED_AT,
    });
  });

  function writeTempReport(contents: unknown): string {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "codepause-report-")),
      "report.json",
    );
    fs.writeFileSync(
      file,
      typeof contents === "string"
        ? contents
        : JSON.stringify(contents, null, 2),
      "utf8",
    );
    return file;
  }

  function runCli(file: string): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, file], {
        encoding: "utf8",
      });
      return { status: 0, output: stdout };
    } catch (err: any) {
      return {
        status: err.status ?? -1,
        output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      };
    }
  }

  describe("AssignmentReportGenerator", () => {
    it("writes a complete report as formatted UTF-8 JSON", async () => {
      const writeFile = jest.fn().mockResolvedValue(undefined);
      const target = { fsPath: "/tmp/assignment.report.json" };

      await writeAssignmentReport(writeFile, target, report);

      expect(writeFile).toHaveBeenCalledWith(
        target,
        Buffer.from(JSON.stringify(report, null, 2), "utf8"),
      );
    });

    it("produces a well-formed report matching the AssignmentReport type", () => {
      expect(report.reportVersion).toBe("1.0");
      expect(report.assignmentId).toBe("asgn-hw1-2025");
      expect(report.assignmentName).toBe("HW1 - Linked Lists");
      expect(report.generatedAt).toBe(FIXED_GENERATED_AT);
      expect(report.studentIdentifier).toBe("student-042");
      expect(report.repoUrl).toBe("https://github.com/student/hw1");
      expect(report.repoHeadCommit).toBe("abc123def456");
      expect(report.policy).toEqual(policy);
      expect(report.integrity.algorithm).toBe("sha256");
      expect(report.integrity.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("carries the exact authorship/ownership numbers from PolicyEngine", () => {
      expect(report.metrics.authorship.totalLines).toBe(200);
      expect(report.metrics.authorship.manualLines).toBe(100);
      expect(report.metrics.authorship.permittedAILines).toBe(50);
      expect(report.metrics.authorship.prohibitedAILines).toBe(30);
      expect(report.metrics.authorship.flaggedAILines).toBe(20);
      expect(report.metrics.authorship.authorshipPercentage).toBeCloseTo(50, 5);
      expect(report.metrics.authorship.prohibitedPercentage).toBeCloseTo(15, 5);
      expect(report.metrics.ownership.score).toBeCloseTo(80, 5);
      expect(report.metrics.ownership.filesReviewed).toBe(1);
      expect(report.metrics.ownership.filesUnreviewed).toBe(1);
      expect(report.metrics.ownership.unreviewedLines).toBe(20);
    });

    it("is fully reproducible: recomputed metrics + re-export = same hash", () => {
      // The whole point of the integrity scheme: as long as the underlying
      // data does not change, exporting over and over yields the same hash.
      // This requires violation timestamps to come from event data, not
      // wall-clock Date.now() (fixed in PolicyEngine).
      const recomputed = new PolicyEngine().computeMetrics(
        assignment,
        fixtureEvents,
        fixtureReviews,
      );
      const again = generator.generate(assignment, recomputed, {
        studentIdentifier: "student-042",
        repoUrl: assignment.repoUrl,
        repoHeadCommit: "abc123def456",
        generatedAt: FIXED_GENERATED_AT,
      });
      expect(again.integrity.hash).toBe(report.integrity.hash);
    });

    it("hash is stable across export times (generatedAt is informational)", () => {
      const later = generator.generate(assignment, report.metrics, {
        studentIdentifier: "student-042",
        repoUrl: assignment.repoUrl,
        repoHeadCommit: "abc123def456",
        generatedAt: FIXED_GENERATED_AT + 1000,
      });
      // The export timestamp differs but is NOT part of the signed payload...
      expect(later.generatedAt).toBe(FIXED_GENERATED_AT + 1000);
      // ...so the integrity hash stays identical for unchanged metrics.
      expect(later.integrity.hash).toBe(report.integrity.hash);
      expect(generator.verify(later)).toBe(true);
    });

    it("verify() accepts its own reports", () => {
      expect(generator.verify(report)).toBe(true);
    });

    it("verify() rejects reports with modified numbers", () => {
      const tampered: AssignmentReport = JSON.parse(JSON.stringify(report));
      tampered.metrics.authorship.prohibitedAILines = 0;
      expect(generator.verify(tampered)).toBe(false);
    });

    it("canonicalize sorts keys recursively and preserves array order", () => {
      const canonical = AssignmentReportGenerator.canonicalize({
        b: 1,
        a: { d: [2, 1], c: "x" },
      });
      expect(canonical).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    });
  });

  describe("verify-assignment-report CLI (separate process)", () => {
    it("accepts a freshly exported report (exit 0, INTEGRITY OK)", () => {
      const file = writeTempReport(report);
      const result = runCli(file);

      expect(result.status).toBe(0);
      expect(result.output).toContain("INTEGRITY OK");
      expect(result.output).toContain("HW1 - Linked Lists");
      expect(result.output).toContain("50.0% AI");
    });

    it("rejects a report with tampered authorship numbers (exit 1)", () => {
      const tampered: AssignmentReport = JSON.parse(JSON.stringify(report));
      tampered.metrics.authorship.authorshipPercentage = 5;
      tampered.metrics.authorship.permittedAILines = 10;

      const result = runCli(writeTempReport(tampered));

      expect(result.status).toBe(1);
      expect(result.output).toContain("INTEGRITY CHECK FAILED");
      expect(result.output).toContain("hash mismatch");
    });

    it("rejects a report with a tampered policy (exit 1)", () => {
      const tampered: AssignmentReport = JSON.parse(JSON.stringify(report));
      tampered.policy.maxAuthorshipPercentage = 100;

      expect(runCli(writeTempReport(tampered)).status).toBe(1);
    });

    it("rejects a report with a forged integrity hash (exit 1)", () => {
      const tampered: AssignmentReport = JSON.parse(JSON.stringify(report));
      tampered.integrity.hash = "0".repeat(64);

      const result = runCli(writeTempReport(tampered));
      expect(result.status).toBe(1);
      expect(result.output).toContain("hash mismatch");
    });

    it("rejects structurally invalid reports (exit 1)", () => {
      expect(runCli(writeTempReport({ hello: "world" })).status).toBe(1);
      expect(
        runCli(writeTempReport({ ...report, reportVersion: "9.9" })).status,
      ).toBe(1);
      const badHash = JSON.parse(JSON.stringify(report));
      badHash.integrity.hash = "not-a-hash";
      expect(runCli(writeTempReport(badHash)).status).toBe(1);
    });

    it("exits 2 for missing files and invalid JSON", () => {
      expect(runCli("/nonexistent/report.json").status).toBe(2);
      expect(runCli(writeTempReport("{not json")).status).toBe(2);
    });
  });
});
