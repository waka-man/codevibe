import { describe, it, expect } from '@jest/globals';
import { computeDailyTrend, renderTrendChartSvg, renderGaugeSvg } from '../chartSvg';
import { TrackingEvent } from '../../types';

function makeEvent(daysAgo: number, source: 'ai' | 'manual', lines: number): TrackingEvent {
  const timestamp = Date.now() - daysAgo * 86400000;
  return {
    timestamp,
    tool: 'copilot',
    eventType: 'code-generated' as never,
    source,
    linesOfCode: lines,
  } as TrackingEvent;
}

describe('computeDailyTrend', () => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

  it('attributes AI lines to the AI bucket and splits percentages correctly', () => {
    const events = [
      makeEvent(0, 'ai', 80),
      makeEvent(0, 'manual', 20),
      makeEvent(1, 'ai', 10),
      makeEvent(1, 'manual', 90),
    ];
    const trend = computeDailyTrend(events, yesterdayStr, todayStr);
    expect(trend).toHaveLength(2);
    expect(trend[1].aiPercent).toBe(80);
    expect(trend[0].aiPercent).toBe(10);
  });

  it('produces zero-point days as AI 0% even with no events', () => {
    const trend = computeDailyTrend([], yesterdayStr, todayStr);
    expect(trend).toHaveLength(2);
    expect(trend.every((p) => p.aiLines === 0 && p.totalLines === 0 && p.aiPercent === 0)).toBe(true);
  });

  it('ignores events outside the window', () => {
    const events = [makeEvent(30, 'ai', 100), makeEvent(0, 'ai', 25)];
    const trend = computeDailyTrend(events, yesterdayStr, todayStr);
    const day0 = trend.find((p) => p.date === todayStr);
    expect(day0?.aiLines).toBe(25);
  });

  it('returns empty array for an invalid window', () => {
    expect(computeDailyTrend([makeEvent(0, 'ai', 10)], 'notadate', 'also-not-a-date')).toEqual([]);
  });
});

describe('renderTrendChartSvg', () => {
  it('renders a placeholder when there are no points', () => {
    const svg = renderTrendChartSvg([]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('No events');
  });

  it('renders a path and points for valid trend points', () => {
    const svg = renderTrendChartSvg([
      { date: '2026-11-01', aiPercent: 20, aiLines: 10, totalLines: 50 },
      { date: '2026-11-02', aiPercent: 70, aiLines: 70, totalLines: 100 },
    ]);
    expect(svg).toContain('<path');
    expect(svg).toContain('<circle');
    expect(svg).toContain('100%');
  });
});

describe('renderGaugeSvg', () => {
  it('renders a gauge with the clamped value and tone text', () => {
    const svg = renderGaugeSvg(120, 'AI AUTHORSHIP %', 'bad');
    expect(svg).toContain('100');
    expect(svg).toContain('AI AUTHORSHIP %');
    expect(svg).toContain('#ef4444');
  });

  it('clamps to the 0..100 range', () => {
    const svg = renderGaugeSvg(-10, 'OWNERSHIP', 'good');
    expect(svg).toContain('0');
  });
});