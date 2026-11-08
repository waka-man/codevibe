/**
 * AssignmentPdfGenerator
 *
 * Renders the AssignmentReport as a CodeVibe-branded, instructor-facing PDF.
 * Presentational companion to the JSON report; the JSON remains the
 * authoritative, integrity-checked artifact and is NOT re-serialized here.
 *
 * Unit-testable by construction: no vscode imports, font paths resolved
 * relative to this module's compiler location.
 */

import pdfmake from "pdfmake";
import {
  AssignmentReport,
  TrackingEvent,
} from "../types";
import {
  computeDailyTrend,
  renderTrendChartSvg,
  renderGaugeSvg,
} from "./chartSvg";

// pdfmake's font files have no type declarations; cast once.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Roboto = require("pdfmake/fonts/Roboto") as {
  Roboto: { normal: string; bold: string; italics: string; bolditalics: string };
};

pdfmake.addFonts(Roboto as never);
// pdfmake loads fonts from disk, so the local-access policy must permit
// exactly the Roboto files shipped next to the bundle (out/Roboto/). This
// grants nothing else on the filesystem.
pdfmake.setLocalAccessPolicy((p: string) => {
  const norm = (p ?? '').replace(/\\/g, '/');
  const marker = norm.lastIndexOf('/out/Roboto/');
  if (marker === -1) return false;
  const sub = norm.slice(marker + '/out/Roboto/'.length);
  return /^Roboto-(Regular|Medium|Italic|MediumItalic)\.ttf$/.test(sub);
});
pdfmake.setUrlAccessPolicy(() => false);

const TAGLINE = "Pause. Review. Own your code.";

// The CodeVibe logo SVG, inlined so the PDF is self-contained.
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="24" fill="#4A90E2"/>
  <g transform="translate(64, 64)">
    <path d="M -20 -5 Q -25 -15, -18 -22 Q -10 -28, -2 -24 Q 5 -28, 12 -24 Q 20 -28, 25 -20 Q 30 -10, 25 0 Q 28 8, 22 15 Q 15 20, 8 18 Q 3 22, -3 22 Q -10 22, -15 18 Q -22 15, -25 8 Q -30 0, -25 -8 Z" fill="white" opacity="0.95"/>
    <rect x="-6" y="-8" width="4" height="16" rx="1.5" fill="#4A90E2"/>
    <rect x="2" y="-8" width="4" height="16" rx="1.5" fill="#4A90E2"/>
  </g>
</svg>`;

export class AssignmentPdfGenerator {
  /**
   * Build a Buffer with the PDF bytes for the given report.
   */
  async generatePdfBuffer(report: AssignmentReport): Promise<Buffer> {
    const docDefinition = this.buildDocumentDefinition(report);
    const buffer = await pdfmake.createPdf(docDefinition as never).getBuffer();
    return Buffer.from(buffer);
  }

  /**
   * True if there is no AI/review activity in the window.
   */
  private isEmpty(report: AssignmentReport): boolean {
    return (
      report.metrics.authorship.totalLines === 0 &&
      report.metrics.rawEvents.length === 0
    );
  }

  private buildDocumentDefinition(
    report: AssignmentReport,
  ): Record<string, unknown> {
    const m = report.metrics;
    const policy = report.policy;
    const empty = this.isEmpty(report);

    const authorshipTone: "good" | "warn" | "bad" =
      m.authorship.authorshipPercentage <= policy.maxAuthorshipPercentage ? "good"
        : m.authorship.authorshipPercentage <= 90 ? "warn"
        : "bad";
    const ownershipTone: "good" | "warn" | "bad" =
      m.ownership.score >= policy.minOwnershipScore ? "good"
        : m.ownership.score >= 20 ? "warn"
        : "bad";

    const trend = computeDailyTrend(
      m.rawEvents as TrackingEvent[],
      report.assignmentName ? (this.getAssignmentStart(report) ?? "") : "",
      this.getAssignmentEnd(report) ?? "",
    );

    return {
      pageSize: "A4",
      pageMargins: [36, 48, 36, 52],
      info: {
        title: `${report.assignmentName} — CodeVibe Assignment Report`,
        author: "CodeVibe",
        subject: "Assignment Integrity Report",
        keywords: "codevibe, AI, assignment, integrity",
      },
      styles: {
        title: { fontSize: 20, bold: true, color: "#0f172a", margin: [0, 0, 0, 4] },
        subtitle: { fontSize: 10, color: "#64748b", margin: [0, 0, 0, 14] },
        sectionHeader: { fontSize: 12, bold: true, color: "#0f172a", margin: [0, 16, 0, 8] },
        body: { fontSize: 9, color: "#1f2937" },
        label: { fontSize: 8, color: "#64748b", bold: true, characterSpacing: 0.4 },
        value: { fontSize: 10, bold: true, color: "#0f172a" },
        tableHeader: { fontSize: 8, bold: true, color: "#ffffff", fillColor: "#16213e", margin: [6, 4, 6, 4] },
        tableCell: { fontSize: 8, color: "#1f2937", margin: [6, 4, 6, 4] },
        footerSmall: { fontSize: 7, color: "#9ca3af" },
      },
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 0, 36, 18],
        columns: [
          {
            text: `${report.assignmentName} · Assignment ${report.assignmentId}`,
            style: "footerSmall",
          },
          {
            text: `Page ${currentPage} of ${pageCount}`,
            style: "footerSmall",
            alignment: "right",
          },
        ],
      }),
      content: [
        // ===== Cover header =====
        {
          columns: [
            { svg: LOGO_SVG, width: 40, margin: [0, 2, 0, 0] },
            {
              stack: [
                { text: "CodeVibe", style: "title" },
                { text: TAGLINE, style: "subtitle" },
              ],
              margin: [10, 0, 0, 0],
            },
          ],
          margin: [0, 0, 0, 14],
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 1.5, lineColor: "#00d084" }], margin: [0, 0, 0, 10] },

        { text: "ASSIGNMENT REPORT", style: "label" },
        { text: report.assignmentName, style: { fontSize: 18, bold: true, color: "#0f172a", margin: [0, 2, 0, 2] } },
        report.studentIdentifier
          ? { text: `Submitted by: ${report.studentIdentifier}`, style: "subtitle" }
          : { text: "Unattributed submission", style: "subtitle" },

        {
          columns: [
            {
              stack: [
                { text: "REPO / COMMIT", style: "label" },
                {
                  text: report.repoUrl
                    ? `${report.repoUrl}${report.repoHeadCommit ? " @ " + report.repoHeadCommit.slice(0, 12) : ""}`
                    : "Not provided",
                  style: "value",
                },
              ],
            },
            {
              stack: [
                { text: "GENERATED", style: "label" },
                {
                  text: new Date(report.generatedAt).toLocaleString(),
                  style: "value",
                },
              ],
            },
            {
              stack: [
                { text: "REPORT ID", style: "label" },
                {
                  text: report.integrity.hash.slice(0, 12),
                  style: "value",
                },
              ],
            },
          ],
          margin: [0, 10, 0, 0],
        },

        { text: "SCORE SUMMARY", style: "sectionHeader" },
        {
          columns: [
            { svg: renderGaugeSvg(m.authorship.authorshipPercentage, "AI AUTHORSHIP %", authorshipTone), width: 78 },
            { svg: renderGaugeSvg(m.ownership.score, "OWNERSHIP", ownershipTone), width: 78 },
            {
              stack: [
                { text: m.violations.length, style: { fontSize: 28, bold: true, color: m.violations.length === 0 ? "#22c55e" : "#ef4444", alignment: "center" } },
                { text: m.violations.length === 0 ? "NO VIOLATIONS" : "VIOLATION(S)", style: { fontSize: 8, bold: true, color: "#64748b", alignment: "center", characterSpacing: 0.5 } },
              ],
            },
          ],
          columnGap: 12,
        },

        { text: "AI AUTHORSHIP TREND (PER DAY)", style: "sectionHeader" },
        trend.length > 0
          ? { svg: renderTrendChartSvg(trend), width: 523, margin: [0, 0, 0, 4] }
          : { text: "No events tracked in the assignment window.", style: "subtitle" },

        // ===== Metrics table =====
        { text: "DETAILED METRICS", style: "sectionHeader" },
        {
          table: {
            headerRows: 1,
            widths: ["*", "auto"],
            body: [
              [{ text: "METRIC", style: "tableHeader" }, { text: "VALUE", style: "tableHeader" }],
              [{ text: "Total lines (all sources)", style: "tableCell" }, { text: String(m.authorship.totalLines), style: "tableCell" }],
              [{ text: "Manual lines", style: "tableCell" }, { text: String(m.authorship.manualLines), style: "tableCell" }],
              [{ text: "AI lines — permitted", style: "tableCell" }, { text: String(m.authorship.permittedAILines), style: "tableCell" }],
              [{ text: "AI lines — prohibited", style: "tableCell" }, { text: String(m.authorship.prohibitedAILines), style: "tableCell" }],
              [{ text: "AI lines — flagged", style: "tableCell" }, { text: String(m.authorship.flaggedAILines), style: "tableCell" }],
              [{ text: "AI authorship %", style: "tableCell" }, { text: `${m.authorship.authorshipPercentage.toFixed(1)}% (limit ${policy.maxAuthorshipPercentage}%)`, style: "tableCell" }],
              [{ text: "Ownership score", style: "tableCell" }, { text: `${Math.round(m.ownership.score)} / 100 (min ${policy.minOwnershipScore})`, style: "tableCell" }],
              [{ text: "Files reviewed", style: "tableCell" }, { text: String(m.ownership.filesReviewed), style: "tableCell" }],
              [{ text: "Files unreviewed", style: "tableCell" }, { text: String(m.ownership.filesUnreviewed), style: "tableCell" }],
              [{ text: "Average review time", style: "tableCell" }, { text: `${(m.ownership.averageReviewTimeMs / 1000).toFixed(1)}s`, style: "tableCell" }],
              [{ text: "Tracking gaps", style: "tableCell" }, { text: String(m.trackingGaps.length), style: "tableCell" }],
            ],
          },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0,
            hLineColor: () => "#e5e7eb",
          },
        },

        // ===== Violations =====
        { text: "POLICY VIOLATIONS", style: "sectionHeader" },
        m.violations.length === 0
          ? { text: "No policy violations were detected for this assignment.", style: { ...({} as object), fontSize: 9, color: "#15803d", bold: true } }
          : {
              table: {
                headerRows: 1,
                widths: ["auto", "*", "auto"],
                body: [
                  [{ text: "TYPE", style: "tableHeader" }, { text: "MESSAGE", style: "tableHeader" }, { text: "COUNT", style: "tableHeader" }],
                  ...m.violations.map((v) => [
                    { text: v.type.toUpperCase(), style: "tableCell" },
                    { text: v.message, style: "tableCell" },
                    { text: String(v.count ?? 1), style: "tableCell" },
                  ]),
                ],
              },
              layout: {
                hLineWidth: () => 0.5,
                vLineWidth: () => 0,
                hLineColor: () => "#e5e7eb",
              },
            },

        // ===== Exclusion audit =====
        { text: "EXCLUSION AUDIT", style: "sectionHeader" },
        report.exclusionAudit.length === 0
          ? { text: "No custom exclusion changes were recorded during this assignment.", style: "subtitle" }
          : {
              table: {
                headerRows: 1,
                widths: ["auto", "*", "auto"],
                body: [
                  [{ text: "WHEN", style: "tableHeader" }, { text: "GLOBS", style: "tableHeader" }, { text: "SOURCE", style: "tableHeader" }],
                  ...report.exclusionAudit.map((e) => [
                    { text: new Date(e.timestamp).toLocaleString(), style: "tableCell" },
                    { text: e.globs.join(", ") || "(none)", style: "tableCell" },
                    { text: e.source, style: "tableCell" },
                  ]),
                ],
              },
              layout: {
                hLineWidth: () => 0.5,
                vLineWidth: () => 0,
                hLineColor: () => "#e5e7eb",
              },
            },

        {
          columns: [
            {
              stack: [
                { text: empty ? "NO TRACKED ACTIVITY IN THIS WINDOW" : "SIGNED REPORT", style: "label" },
                {
                  text: empty
                    ? "No AI or manual events were recorded during the assignment window."
                    : "The JSON companion to this document carries a SHA-256 integrity hash over the full metrics payload, and it is what the instructor's verifier checks.",
                  style: "body",
                },
              ],
            },
          ],
          margin: [0, 14, 0, 0],
        },
      ],
    };
  }

  private getAssignmentStart(report: AssignmentReport): string {
    // AssignmentPolicy doesn't carry the window; use the earliest event date.
    const times = report.metrics.rawEvents.map((e) => e.timestamp).filter((t) => Number.isFinite(t));
    if (times.length === 0) return "";
    return new Date(Math.min(...times)).toISOString().slice(0, 10);
  }

  private getAssignmentEnd(report: AssignmentReport): string {
    const times = report.metrics.rawEvents.map((e) => e.timestamp).filter((t) => Number.isFinite(t));
    if (times.length === 0) return "";
    return new Date(Math.max(...times)).toISOString().slice(0, 10);
  }
}
