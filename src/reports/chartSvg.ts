/**
 * SVG chart helpers for the assignment PDF report.
 *
 * pdfmake embeds SVG via the `svg` element type, so charts are rendered as
 * pure SVG strings. No canvas, no image libraries, no third-party charting
 * dependencies.
 */

import { TrackingEvent } from "../types";
import { toLocalDateString } from "../utils/DateUtils";

export interface DailyTrendPoint {
  date: string;
  aiPercent: number;
  aiLines: number;
  totalLines: number;
}

/**
 * Group the report's raw events into a per-calendar-day AI-authorship trend,
 * restricted to the assignment window.
 *
 * AI lines count only events sourced as `ai`; every event's lines count into
 * the day's total. Days with no events are reported with aiPercent = 0
 * (flat line), matching how the dashboard counts idle assignment days.
 */
export function computeDailyTrend(
  events: TrackingEvent[],
  startDate: string,
  endDate: string,
): DailyTrendPoint[] {
  const byDay = new Map<string, { aiLines: number; totalLines: number }>();

  // Fill the window with zeroed days so the chart has a full range.
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    return [];
  }
  while (cursor <= end) {
    byDay.set(toLocalDateString(cursor), { aiLines: 0, totalLines: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const event of events) {
    const day = toLocalDateString(new Date(event.timestamp));
    const bucket = byDay.get(day);
    if (!bucket) continue; // outside the window
    const lines = (event.linesOfCode ?? 0) + Math.max(0, event.linesRemoved ?? 0);
    if (lines <= 0) continue;
    bucket.totalLines += lines;
    if (event.source === "ai") {
      bucket.aiLines += lines;
    }
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, { aiLines, totalLines }]) => ({
      date,
      aiLines,
      totalLines,
      aiPercent: totalLines > 0 ? Math.round((aiLines / totalLines) * 1000) / 10 : 0,
    }));
}

const CHART_W = 460;
const CHART_H = 150;
const PAD = 26;

/**
 * Render the trend line chart as a standalone SVG string, suitable for
 * embedding as a pdfmake `svg` element.
 */
export function renderTrendChartSvg(points: DailyTrendPoint[]): string {
  if (points.length === 0) {
    return `<svg width="${CHART_W}" height="${CHART_H}" xmlns="http://www.w3.org/2000/svg">
      <text x="${CHART_W / 2}" y="${CHART_H / 2}" text-anchor="middle" font-size="11" fill="#6b7280">No events in this assignment window</text>
    </svg>`;
  }

  const xFor = (i: number) =>
    points.length === 1 ? CHART_W / 2 : PAD + (i * (CHART_W - 2 * PAD)) / (points.length - 1);
  const maxPercent = Math.max(100, ...points.map((p) => p.aiPercent));
  const yFor = (v: number) => CHART_H - PAD - (Math.min(v, maxPercent) / maxPercent) * (CHART_H - 2 * PAD);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.aiPercent).toFixed(1)}`)
    .join(" ");

  const area =
    points.length > 1
      ? `M ${xFor(0).toFixed(1)} ${yFor(0).toFixed(1)} ` +
        points
          .map((p, i) => (i > 0 ? `L ${xFor(i).toFixed(1)} ${yFor(p.aiPercent).toFixed(1)}` : ""))
          .join(" ") +
        ` L ${xFor(points.length - 1).toFixed(1)} ${CHART_H - PAD} L ${xFor(0).toFixed(1)} ${CHART_H - PAD} Z`
      : "";

  // Y gridlines at 0 / 50 / 100 (or the max)
  const gridLines = [0, 0.5, 1]
    .map((frac) => {
      const y = PAD + frac * (CHART_H - 2 * PAD);
      const label = Math.round(maxPercent * (1 - frac));
      return `
      <line x1="${PAD}" y1="${y}" x2="${CHART_W - PAD}" y2="${y}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="${frac === 1 ? "" : "3,3"}"/>
      <text x="${PAD - 4}" y="${y + 3}" text-anchor="end" font-size="7" fill="#6b7280">${label}%</text>`;
    })
    .join("");

  // Sparse x labels: first, middle, last
  const xIndices = points.length === 1
    ? [0]
    : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xLabels = xIndices
    .map((i) => {
      const p = points[i];
      return `<text x="${xFor(i).toFixed(1)}" y="${CHART_H - 6}" text-anchor="middle" font-size="6.5" fill="#6b7280">${p.date.slice(5)}</text>`;
    })
    .join("");

  return `<svg width="${CHART_W}" height="${CHART_H}" xmlns="http://www.w3.org/2000/svg">
    ${gridLines}
    ${area ? `<path d="${area}" fill="#00d084" fill-opacity="0.12"/>` : ""}
    <path d="${path}" fill="none" stroke="#00d084" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.aiPercent).toFixed(1)}" r="2.2" fill="#00d084"/>`).join("")}
    ${xLabels}
  </svg>`;
}

/**
 * Render a compact semicircular gauge for a single 0-100 metric.
 */
export function renderGaugeSvg(value: number, label: string, tone: "good" | "warn" | "bad"): string {
  const clamped = Math.max(0, Math.min(100, value));
  const color = tone === "good" ? "#22c55e" : tone === "warn" ? "#f59e0b" : "#ef4444";
  const fillWidth = (10 + 60 * (clamped / 100)).toFixed(1);

  return `<svg width="80" height="52" viewBox="0 0 80 52" xmlns="http://www.w3.org/2000/svg">
    <path d="M 10 42 A 30 30 0 0 1 70 42" fill="none" stroke="#e5e7eb" stroke-width="6" stroke-linecap="round"/>
    <path d="M 10 42 A 30 30 0 0 1 ${fillWidth} 42" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
    <text x="40" y="34" text-anchor="middle" font-size="15" font-weight="700" fill="#111827">${Math.round(clamped)}</text>
    <text x="40" y="46" text-anchor="middle" font-size="6" fill="#6b7280">${label}</text>
  </svg>`;
}
