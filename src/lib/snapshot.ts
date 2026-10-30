/**
 * 每日快照的純函式：把掃描結果攤平成 CSV 列、合併進月檔（同一天同一檔會被覆寫）、
 * 以及用後續快照算出「N 個交易日後報酬」標籤。不碰網路與檔案，方便測試。
 *
 * 型別只用結構（不 import scan-core），讓這個檔案能直接在 Node 單元測試裡跑。
 */

export type Cell = string | number | boolean | null | undefined;
export type Record_ = Record<string, Cell>;

export const TW_COLUMNS = [
  "session_date", "snapshot_at", "code", "name", "sector",
  "close", "change_pct", "open", "high", "low", "volume",
  "ma5", "ma10", "ma20", "ma60", "spread_pct", "vol_ratio", "upper_shadow",
  "bearish", "in_gate", "tight", "bull_stack",
  "sop_score", "sop_kind", "flagship_score",
  "chip", "foreign", "trust", "dealer", "total_inst", "chip_date",
  "foreign_streak", "trust_streak", "foreign_5d", "trust_5d", "flow_days",
  "margin_bal", "margin_chg", "margin_chg_pct", "margin_use", "short_bal", "short_ratio", "margin_side",
  "big_pct", "big_change", "big_streak", "holder_side", "holder_date",
  "sector_ratio", "ret20", "ret60", "rs20", "pe", "pb", "div_yield",
  "settlement", "bench_price", "bench_change_pct", "bench_ret20",
] as const;

export const US_COLUMNS = [
  "session_date", "snapshot_at", "symbol", "name", "sector",
  "close", "change_pct", "open", "high", "low", "volume",
  "ma5", "ma10", "ma20", "ma60", "spread_pct", "vol_ratio", "upper_shadow",
  "bearish", "in_gate", "tight", "bull_stack",
  "sop_score", "sop_kind", "flagship_score", "ret20", "rs20",
  "earnings_days", "earnings_near", "implied_move_pct", "implied_iv",
  "insider_applicable", "insider_known", "insider_bought", "insider_usd", "insider_bonus",
  "net_liq", "net_liq_chg4w", "net_liq_status", "rrp", "rrp_chg5d",
  "bench_price", "bench_change_pct", "bench_ret20",
] as const;

export const TW_SECTOR_COLUMNS = ["session_date", "sector", "stocks", "share5", "share20", "ratio", "trend"] as const;
export const US_ETF_COLUMNS = ["session_date", "symbol", "name", "rel5", "rel20", "vol_ratio"] as const;
export const LABEL_COLUMNS = ["session_date", "id", "close", "fwd1", "fwd5", "fwd10", "bench_fwd5", "excess5"] as const;

// ---------- CSV ----------

function escapeCell(value: Cell): string {
  if (value == null) return "";
  const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record_[], columns: readonly string[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}

/** RFC 4180 的簡化版：支援引號、逗號、換行；所有值都當字串。 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/**
 * 把新列併進既有列：以 keyOf 為主鍵，新資料覆寫同一天同一檔的舊資料
 * （盤後重跑或補跑時，以最後一次為準），再依主鍵排序。
 */
export function mergeRows(
  existing: Array<Record<string, string>>,
  incoming: Record_[],
  columns: readonly string[],
  keyOf: (row: Record<string, Cell>) => string,
): Array<Record<string, Cell>> {
  const byKey = new Map<string, Record<string, Cell>>();
  for (const row of existing) byKey.set(keyOf(row), row);
  for (const row of incoming) {
    const normalized: Record<string, Cell> = {};
    for (const c of columns) normalized[c] = row[c];
    byKey.set(keyOf(normalized), normalized);
  }
  return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, row]) => row);
}

export function monthOf(sessionDate: string) {
  return sessionDate.slice(0, 7);
}

// ---------- 攤平 ----------

const r = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export interface TwRowLike {
  code: string; name: string; sector: string; price: number; changePct: number;
  open: number; high: number; low: number; volume: number;
  ma5: number; ma10: number; ma20: number; ma60: number;
  spreadPct: number; volRatio: number; upperShadow: number;
  bearish: boolean; inGate: boolean; tight: boolean; bullStack: boolean;
  sopScore: number | null; sopKind: string; flagshipScore: number;
  chip: string; foreign: number | null; trust: number | null; dealer: number | null; totalInst: number | null;
  ret20: number | null; ret60: number | null; rs20: number | null;
  pe: number | null; pb: number | null; dividendYield: number | null;
  holderSide: string; bigPct: number | null; bigChange: number | null; bigStreak: number | null;
  sectorRatio: number | null;
  flow: { foreignStreak: number; trustStreak: number; foreign5d: number; trust5d: number; days: number } | null;
  margin: {
    marginBal: number; marginChange: number; marginChangePct: number; marginUse: number | null;
    shortBal: number; shortRatio: number | null; side: string;
  } | null;
}

export interface TwScanLike {
  scannedAt: number; sessionDate: string; chipDate: string | null; holderDate: string | null;
  settlement: boolean; flowDays: number;
  benchmark: { price: number; changePct: number; ret20: number | null } | null;
  rows: TwRowLike[];
  sectors: Array<{ sector: string; stocks: number; share5: number; share20: number; ratio: number; trend: string }>;
}

export function flattenTw(scan: TwScanLike): { stocks: Record_[]; sectors: Record_[] } {
  const at = new Date(scan.scannedAt).toISOString();
  const stocks = scan.rows.map((x): Record_ => ({
    session_date: scan.sessionDate, snapshot_at: at, code: x.code, name: x.name, sector: x.sector,
    close: x.price, change_pct: x.changePct, open: x.open, high: x.high, low: x.low, volume: x.volume,
    ma5: x.ma5, ma10: x.ma10, ma20: x.ma20, ma60: x.ma60,
    spread_pct: x.spreadPct, vol_ratio: x.volRatio, upper_shadow: x.upperShadow,
    bearish: x.bearish, in_gate: x.inGate, tight: x.tight, bull_stack: x.bullStack,
    sop_score: x.sopScore, sop_kind: x.sopKind, flagship_score: x.flagshipScore,
    chip: x.chip, foreign: x.foreign, trust: x.trust, dealer: x.dealer, total_inst: x.totalInst, chip_date: scan.chipDate,
    foreign_streak: x.flow?.foreignStreak, trust_streak: x.flow?.trustStreak,
    foreign_5d: x.flow?.foreign5d, trust_5d: x.flow?.trust5d, flow_days: x.flow?.days,
    margin_bal: x.margin?.marginBal, margin_chg: x.margin?.marginChange, margin_chg_pct: x.margin?.marginChangePct,
    margin_use: x.margin?.marginUse, short_bal: x.margin?.shortBal, short_ratio: x.margin?.shortRatio,
    margin_side: x.margin?.side,
    big_pct: x.bigPct, big_change: x.bigChange, big_streak: x.bigStreak, holder_side: x.holderSide, holder_date: scan.holderDate,
    sector_ratio: x.sectorRatio, ret20: x.ret20, ret60: x.ret60, rs20: x.rs20,
    pe: x.pe, pb: x.pb, div_yield: x.dividendYield,
    settlement: scan.settlement,
    bench_price: scan.benchmark?.price, bench_change_pct: scan.benchmark?.changePct, bench_ret20: scan.benchmark?.ret20,
  }));
  const sectors = scan.sectors.map((s): Record_ => ({ session_date: scan.sessionDate, ...s }));
  return { stocks, sectors };
}

export interface UsRowLike {
  symbol: string; name: string; sector: string; price: number; changePct: number;
  open: number; high: number; low: number; volume: number;
  ma5: number; ma10: number; ma20: number; ma60: number;
  spreadPct: number; volRatio: number; upperShadow: number;
  bearish: boolean; inGate: boolean; tight: boolean; bullStack: boolean;
  sopScore: number | null; sopKind: string; flagshipScore: number; ret20: number | null; rs20: number | null;
  earningsDays: number | null; earningsNear: boolean; impliedMovePct: number | null; impliedIv: number | null;
  insiderApplicable: boolean; insiderKnown: boolean; insiderBought: boolean; insiderUsd: number; insiderBonus: boolean;
}

export interface UsScanLike {
  scannedAt: number; sessionDate: string;
  benchmark: { price: number; changePct: number; ret20: number | null } | null;
  liquidity: { value: number; changeAbs: number };
  netLiquidity: { value: number; changeAbs: number; status: string };
  etfs: Array<{ symbol: string; name: string; rel5: number | null; rel20: number | null; volRatio: number | null }>;
  rows: UsRowLike[];
}

export function flattenUs(scan: UsScanLike): { stocks: Record_[]; etfs: Record_[] } {
  const at = new Date(scan.scannedAt).toISOString();
  const stocks = scan.rows.map((x): Record_ => ({
    session_date: scan.sessionDate, snapshot_at: at, symbol: x.symbol, name: x.name, sector: x.sector,
    close: x.price, change_pct: x.changePct, open: x.open, high: x.high, low: x.low, volume: x.volume,
    ma5: x.ma5, ma10: x.ma10, ma20: x.ma20, ma60: x.ma60,
    spread_pct: x.spreadPct, vol_ratio: x.volRatio, upper_shadow: x.upperShadow,
    bearish: x.bearish, in_gate: x.inGate, tight: x.tight, bull_stack: x.bullStack,
    sop_score: x.sopScore, sop_kind: x.sopKind, flagship_score: x.flagshipScore, ret20: x.ret20, rs20: x.rs20,
    earnings_days: x.earningsDays, earnings_near: x.earningsNear, implied_move_pct: x.impliedMovePct, implied_iv: x.impliedIv,
    insider_applicable: x.insiderApplicable, insider_known: x.insiderKnown, insider_bought: x.insiderBought,
    insider_usd: x.insiderUsd, insider_bonus: x.insiderBonus,
    net_liq: r(scan.netLiquidity.value, 1), net_liq_chg4w: r(scan.netLiquidity.changeAbs, 1), net_liq_status: scan.netLiquidity.status,
    rrp: r(scan.liquidity.value, 2), rrp_chg5d: r(scan.liquidity.changeAbs, 2),
    bench_price: scan.benchmark?.price, bench_change_pct: scan.benchmark?.changePct, bench_ret20: scan.benchmark?.ret20,
  }));
  const etfs = scan.etfs.map((e): Record_ => ({
    session_date: scan.sessionDate, symbol: e.symbol, name: e.name, rel5: e.rel5, rel20: e.rel20, vol_ratio: e.volRatio,
  }));
  return { stocks, etfs };
}

// ---------- 標籤：N 個交易日後的報酬 ----------

export interface PricePoint {
  date: string;
  id: string;
  close: number;
  bench: number | null;
}

function dayDiff(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * 依「快照序列」往後數 N 筆當作 N 個交易日後。若中間快照缺漏（日曆天差距過大），該標籤留空，
 * 避免把缺資料誤當成連續交易日。fwd 是百分比；excess5 = 個股 5 日報酬 − 大盤 5 日報酬。
 */
export function computeLabels(points: PricePoint[]): Record_[] {
  const byId = new Map<string, PricePoint[]>();
  for (const p of points) {
    const list = byId.get(p.id) ?? [];
    list.push(p);
    byId.set(p.id, list);
  }
  const out: Record_[] = [];
  const pct = (a: number, b: number) => (a > 0 ? r(((b / a) - 1) * 100, 3) : null);
  for (const [id, list] of byId) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    list.forEach((p, i) => {
      const at = (n: number) => {
        const q = list[i + n];
        return q && dayDiff(p.date, q.date) <= n * 2 + 3 ? q : null;
      };
      const f1 = at(1);
      const f5 = at(5);
      const f10 = at(10);
      const fwd5 = f5 ? pct(p.close, f5.close) : null;
      const benchFwd5 = f5 && p.bench != null && f5.bench != null ? pct(p.bench, f5.bench) : null;
      out.push({
        session_date: p.date,
        id,
        close: p.close,
        fwd1: f1 ? pct(p.close, f1.close) : null,
        fwd5,
        fwd10: f10 ? pct(p.close, f10.close) : null,
        bench_fwd5: benchFwd5,
        excess5: fwd5 != null && benchFwd5 != null ? r(fwd5 - benchFwd5, 3) : null,
      });
    });
  }
  return out.sort((a, b) => `${a.session_date}|${a.id}`.localeCompare(`${b.session_date}|${b.id}`));
}
