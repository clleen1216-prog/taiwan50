import type { HolderInfo } from "./score.ts";

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function bigHolderSeries(
  rows: Array<{ date?: string; HoldingSharesLevel?: string; percent?: number | string }>,
) {
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const level = String(row.HoldingSharesLevel ?? "");
    if (!row.date || /total|合計|差異/i.test(level)) continue;
    const first = level.match(/[\d,]+/);
    if (!first) continue;
    const lower = Number(first[0].replace(/,/g, ""));
    if (!Number.isFinite(lower) || lower < 1_000_001) continue;
    const pct = toNumber(row.percent);
    if (pct == null) continue;
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + pct);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function toHolderInfo(series: Array<[string, number]>): HolderInfo | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  let streak = 0;
  for (let i = series.length - 1; i >= 1; i -= 1) {
    const diff = series[i]![1] - series[i - 1]![1];
    if (Math.abs(diff) < 0.005) break;
    const dir = diff > 0 ? 1 : -1;
    if (streak === 0) streak = dir;
    else if (Math.sign(streak) === dir) streak += dir;
    else break;
  }
  return {
    pct: round2(last[1]),
    change: round2(last[1] - prev[1]),
    streak,
    date: last[0],
  };
}

