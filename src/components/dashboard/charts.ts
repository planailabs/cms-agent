/**
 * Dashboard charts — ported from chat/'s dashboard charts.ts.
 *
 * Reduced to the token-usage chart backed by GET /api/admin/usage
 * (per-day stacked input/output columns). Theme-aware via the page's
 * data-theme attribute and the app's CSS variables.
 */

import ApexCharts from 'apexcharts';
import { t, uiLocale } from '@/lib/i18n';
import { isDarkTheme } from './logic';

// ── API types (GET /api/admin/usage) ─────────────────────────────────────────

export type UsagePerDay = { day: string; input: number; output: number };
export type UsagePerUser = {
  userId: string;
  email: string;
  name: string;
  input: number;
  output: number;
};
export type UsageResponse = {
  days: number;
  perUser: UsagePerUser[];
  perDay: UsagePerDay[];
};

let usageChart: ApexCharts | null = null;

/** Reads a CSS custom property from the document root. */
const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
};

const buildSeries = (perDay: UsagePerDay[]) => [
  {
    name: t(uiLocale(), 'dashboard.tokens.seriesInput'),
    data: perDay.map((d) => ({ x: d.day, y: d.input })),
  },
  {
    name: t(uiLocale(), 'dashboard.tokens.seriesOutput'),
    data: perDay.map((d) => ({ x: d.day, y: d.output })),
  },
];

/**
 * Renders (or updates) the per-day stacked input/output token chart
 * inside the given element.
 */
export function renderUsageChart(el: HTMLElement, perDay: UsagePerDay[]): void {
  const series = buildSeries(perDay);

  if (usageChart) {
    void usageChart.updateSeries(series);
    return;
  }

  const dark = isDarkTheme();
  const labelColor = dark ? '#aaa' : '#666';

  const options: ApexCharts.ApexOptions = {
    series,
    chart: {
      type: 'bar',
      stacked: true,
      height: '100%',
      toolbar: { show: false },
      background: 'transparent',
      animations: { enabled: false },
      zoom: { enabled: true, type: 'x', autoScaleYaxis: true },
    },
    theme: { mode: dark ? 'dark' : 'light' },
    plotOptions: {
      bar: { borderRadius: 2, columnWidth: '70%' },
    },
    dataLabels: { enabled: false },
    stroke: { width: 0 },
    xaxis: {
      type: 'datetime',
      labels: { style: { colors: labelColor }, datetimeUTC: true },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: {
      labels: {
        style: { colors: labelColor },
        formatter: (val: number) =>
          val >= 1000 ? `${(val / 1000).toFixed(0)}k` : String(val),
      },
      title: {
        text: t(uiLocale(), 'dashboard.tokens.yAxisTokens'),
        style: { color: labelColor },
      },
    },
    grid: {
      borderColor: cssVar('--border-muted', '#333'),
      strokeDashArray: 4,
      padding: { left: 10, right: 10, bottom: 10 },
    },
    legend: { position: 'top', labels: { colors: labelColor } },
    tooltip: {
      theme: dark ? 'dark' : 'light',
      x: { format: 'MMM dd' },
    },
    colors: [cssVar('--accent', '#a882ff'), cssVar('--accent-strong', '#53dfdd')],
  };

  el.innerHTML = '';
  usageChart = new ApexCharts(el, options);
  void usageChart.render();
}
