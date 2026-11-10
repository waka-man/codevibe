import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AssignmentReport } from '../../types';

// Mock pdfmake before importing the generator (module has side effects)
jest.mock('pdfmake', () => {
  const api = {
    addFonts: jest.fn(),
    setLocalAccessPolicy: jest.fn(),
    setUrlAccessPolicy: jest.fn(),
    createPdf: jest.fn(() => ({
      getBuffer: async () => Buffer.from('%PDF-1.4 mock'),
    })),
  };
  return api;
});

import { AssignmentPdfGenerator } from '../AssignmentPdfGenerator';

function makeReport(overrides: Partial<AssignmentReport> = {}): AssignmentReport {
  const base: AssignmentReport = {
    reportVersion: '1.0',
    assignmentId: 'assign-1',
    assignmentName: 'Homework 3',
    generatedAt: Date.now(),
    studentIdentifier: 'student-123',
    repoUrl: 'https://github.com/example/repo',
    repoHeadCommit: 'abcdef1234567890',
    metrics: {
      assignmentId: 'assign-1',
      authorship: {
        totalLines: 200,
        manualLines: 120,
        permittedAILines: 50,
        prohibitedAILines: 20,
        flaggedAILines: 10,
        authorshipPercentage: 40,
        prohibitedPercentage: 10,
      },
      ownership: {
        score: 75,
        filesReviewed: 5,
        filesUnreviewed: 2,
        unreviewedLines: 30,
        averageReviewTimeMs: 4500,
      },
      violations: [
        {
          type: 'prohibited-ai' as never,
          severity: 'high',
          message: 'Prohibited AI usage detected',
          details: {},
          firstDetectedAt: Date.now() - 1000,
          lastDetectedAt: Date.now(),
          count: 2,
        },
      ],
      rawEvents: [
        {
          timestamp: Date.now() - 86400000,
          tool: 'copilot',
          eventType: 'code-generated' as never,
          source: 'ai',
          linesOfCode: 50,
        } as never,
        {
          timestamp: Date.now(),
          tool: 'manual',
          eventType: 'code-generated' as never,
          source: 'manual',
          linesOfCode: 30,
        } as never,
      ],
      fileReviews: [],
      trackingGaps: [
        { startTime: Date.now() - 5000, endTime: Date.now() - 1000, durationSeconds: 4 },
      ],
    },
    policy: {
      maxAuthorshipPercentage: 50,
      minOwnershipScore: 60,
      exemptFileGlobs: [],
      prohibitedMethods: [],
      permittedMethods: [],
      flaggedMethods: [],
      minLargePasteReviewTimeMs: 2000,
      maxTrackingGapSeconds: 300,
    },
    exclusionAudit: [
      { timestamp: Date.now(), globs: ['**/vendor/**'], source: 'settings' },
    ],
    integrity: {
      algorithm: 'sha256',
      hash: 'a'.repeat(64),
    },
  };
  return { ...base, ...overrides };
}

describe('AssignmentPdfGenerator', () => {
  let generator: AssignmentPdfGenerator;

  beforeEach(() => {
    generator = new AssignmentPdfGenerator();
  });

  it('generates a PDF buffer for a populated report', async () => {
    const report = makeReport();
    const buffer = await generator.generatePdfBuffer(report);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates a PDF for an empty report with no violations, events, or audit', async () => {
    const report = makeReport({
      studentIdentifier: undefined,
      repoUrl: undefined,
      repoHeadCommit: undefined,
      metrics: {
        assignmentId: 'assign-1',
        authorship: {
          totalLines: 0,
          manualLines: 0,
          permittedAILines: 0,
          prohibitedAILines: 0,
          flaggedAILines: 0,
          authorshipPercentage: 0,
          prohibitedPercentage: 0,
        },
        ownership: {
          score: 0,
          filesReviewed: 0,
          filesUnreviewed: 0,
          unreviewedLines: 0,
          averageReviewTimeMs: 0,
        },
        violations: [],
        rawEvents: [],
        fileReviews: [],
        trackingGaps: [],
      },
      exclusionAudit: [],
    });
    const buffer = await generator.generatePdfBuffer(report);
    expect(Buffer.isBuffer(buffer)).toBe(true);
  });

  it('handles high authorship, low ownership, warn tones, and events without timestamps in window helpers', async () => {
    const report = makeReport({
      metrics: {
        assignmentId: 'assign-1',
        authorship: {
          totalLines: 100,
          manualLines: 10,
          permittedAILines: 0,
          prohibitedAILines: 85,
          flaggedAILines: 5,
          authorshipPercentage: 90,
          prohibitedPercentage: 85,
        },
        ownership: {
          score: 25,
          filesReviewed: 1,
          filesUnreviewed: 5,
          unreviewedLines: 85,
          averageReviewTimeMs: 1000,
        },
        violations: [],
        rawEvents: [
          {
            timestamp: Date.now(),
            tool: 'copilot',
            eventType: 'code-generated' as never,
            source: 'ai',
            linesOfCode: 85,
          } as never,
        ],
        fileReviews: [],
        trackingGaps: [],
      },
      policy: {
        maxAuthorshipPercentage: 30,
        minOwnershipScore: 60,
        exemptFileGlobs: [],
        prohibitedMethods: [],
        permittedMethods: [],
        flaggedMethods: [],
        minLargePasteReviewTimeMs: 2000,
        maxTrackingGapSeconds: 300,
      },
    });
    const buffer = await generator.generatePdfBuffer(report);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('builds document definition with footer and various branches', () => {
    const report = makeReport();
    const doc = (generator as any).buildDocumentDefinition(report);
    expect(doc).toBeDefined();
    expect(doc.content).toBeInstanceOf(Array);
    expect(typeof doc.footer).toBe('function');
    const footer = doc.footer(1, 2);
    expect(footer.columns[1].text).toContain('Page 1 of 2');

    // Exercise table layout callbacks (used by pdfmake) for all tables present
    const findTables = (obj: any, out: any[] = []): any[] => {
      if (!obj || typeof obj !== 'object') return out;
      if (Array.isArray(obj)) { for (const o of obj) findTables(o, out); return out; }
      if (obj.table && obj.table.layout) out.push(obj);
      for (const k of Object.keys(obj)) findTables(obj[k], out);
      return out;
    };
    const allTables = findTables(doc.content);
    for (const t of allTables) {
      expect(t.table.layout.hLineWidth(0)).toBe(0.5);
      expect(t.table.layout.vLineWidth(0)).toBe(0);
      expect(t.table.layout.hLineColor(0)).toBe('#e5e7eb');
    }
  });

  it('exercises local access policy callback and empty-table branches', async () => {
    // Trigger the policy callback captured at module init to cover lines 34-38
    const pdfmake = require('pdfmake');
    const policyFn = (pdfmake.setLocalAccessPolicy as jest.Mock).mock.calls[0][0] as (p: string) => boolean;
    expect(policyFn('')).toBe(false);
    expect(policyFn('/tmp/out/Roboto/Roboto-Regular.ttf')).toBe(true);
    expect(policyFn('/tmp/out/Roboto/Roboto-Bold.ttf')).toBe(false); // not in allowed list
    expect(policyFn('/tmp/other/Roboto-Regular.ttf')).toBe(false);

    // Build doc for empty violations and empty exclusion audit to cover those branches
    const report = makeReport({
      metrics: {
        assignmentId: 'assign-1',
        authorship: { totalLines: 0, manualLines: 0, permittedAILines: 0, prohibitedAILines: 0, flaggedAILines: 0, authorshipPercentage: 0, prohibitedPercentage: 0 },
        ownership: { score: 80, filesReviewed: 1, filesUnreviewed: 0, unreviewedLines: 0, averageReviewTimeMs: 1000 },
        violations: [],
        rawEvents: [],
        fileReviews: [],
        trackingGaps: [],
      },
      exclusionAudit: [],
    });
    const doc = (generator as any).buildDocumentDefinition(report);
    const content = doc.content as any[];
    expect(content.some((c: any) => c.text === 'No policy violations were detected for this assignment.')).toBe(true);
    expect(content.some((c: any) => c.text === 'No custom exclusion changes were recorded during this assignment.')).toBe(true);
  });

  it('returns empty date strings when no valid event timestamps', () => {
    const report = makeReport({
      metrics: {
        assignmentId: 'assign-1',
        authorship: {
          totalLines: 0, manualLines: 0, permittedAILines: 0, prohibitedAILines: 0,
          flaggedAILines: 0, authorshipPercentage: 0, prohibitedPercentage: 0,
        },
        ownership: { score: 0, filesReviewed: 0, filesUnreviewed: 0, unreviewedLines: 0, averageReviewTimeMs: 0 },
        violations: [],
        rawEvents: [{ timestamp: Number.NaN } as never],
        fileReviews: [],
        trackingGaps: [],
      },
    });
    const start = (generator as any).getAssignmentStart(report);
    const end = (generator as any).getAssignmentEnd(report);
    expect(start).toBe('');
    expect(end).toBe('');
  });
});
