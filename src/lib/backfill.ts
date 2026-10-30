/**
 * 歷史回填用的純函式。核心原則：每個歷史日期只能用「當天收盤後已經公開」的資料，
 * 避免未來資訊洩漏（lookahead）。例如集保週報是週五結算、週六公布，所以週五那天看不到。
 */
import { toHolderInfo } from "./holders.ts";
import type { HolderInfo } from "./score.ts";
import {
  liquidityFrom,
  netLiquidityFrom,
  summarizeInsiders,
  type InsiderBuy,
  type InsiderSummary,
  type Liquidity,
  type NetLiquidity,
} from "./us-extra.ts";

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWednesday(ymd: string): boolean {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay() === 3;
}

// ---------- 千張大戶（集保週報）----------

/** 只用「結算日嚴格早於 date」的週報（週五結算、週六才公布），取最近 keep 週算連續增減。 */
export function holderAsOf(series: Array<[string, number]>, date: string, keep = 8): HolderInfo | null {
  const usable = series.filter(([d]) => d < date).slice(-keep);
  return toHolderInfo(usable);
}

// ---------- 融資融券歷史 ----------

export interface MarginDay {
  marginBal: number;
  marginPrev: number;
  marginLimit: number | null;
  shortBal: number;
  shortPrev: number;
}

function numOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const n = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 證交所 MI_MARGN（依日期查詢）。欄位名稱會重複（融資、融券各有「今日餘額」），
 * 所以用「第幾個出現」判斷：第 1 個是融資、第 2 個是融券。
 */
export function parseMarginDay(json: {
  tables?: Array<{ fields?: string[]; data?: string[][] }>;
  fields?: string[];
  data?: string[][];
}): Map<string, MarginDay> {
  const out = new Map<string, MarginDay>();
  const candidates = [...(json.tables ?? []), { fields: json.fields, data: json.data }];
  for (const table of candidates) {
    const fields = table.fields ?? [];
    const iCode = fields.findIndex((f) => f === "代號" || f === "股票代號" || f === "證券代號");
    const indexes = (name: string) => fields.map((f, i) => (f === name ? i : -1)).filter((i) => i >= 0);
    const today = indexes("今日餘額");
    const prev = indexes("前日餘額");
    const limit = fields.map((f, i) => (f.includes("限額") ? i : -1)).filter((i) => i >= 0);
    if (iCode < 0 || today.length < 2 || prev.length < 2 || !table.data?.length) continue;
    for (const row of table.data) {
      const code = row[iCode]?.trim();
      const marginBal = numOf(row[today[0]!]);
      const shortBal = numOf(row[today[1]!]);
      const marginPrev = numOf(row[prev[0]!]);
      const shortPrev = numOf(row[prev[1]!]);
      if (!code || marginBal == null || shortBal == null || marginPrev == null || shortPrev == null) continue;
      out.set(code, {
        marginBal,
        marginPrev,
        marginLimit: limit.length ? numOf(row[limit[0]!]) : null,
        shortBal,
        shortPrev,
      });
    }
    if (out.size > 0) break;
  }
  return out;
}

// ---------- 美股：財報日（8-K Item 2.02）----------

/** SEC submissions 的 recent 欄位 → 8-K 且 items 含 2.02（業績公告）的申報日，升冪、去重。 */
export function earningsDatesFrom8K(recent: {
  form?: string[];
  filingDate?: string[];
  items?: string[];
}): string[] {
  const out = new Set<string>();
  const forms = recent.form ?? [];
  for (let i = 0; i < forms.length; i += 1) {
    if (forms[i] !== "8-K") continue;
    if (!(recent.items?.[i] ?? "").split(",").map((x) => x.trim()).includes("2.02")) continue;
    const date = recent.filingDate?.[i];
    if (date) out.add(date);
  }
  return [...out].sort();
}

/** 不早於 date 的最近一次財報日；沒有則 null。 */
export function nextOnOrAfter(sortedDates: string[], date: string): string | null {
  return sortedDates.find((d) => d >= date) ?? null;
}

// ---------- 美股：內部人（以申報日為準）----------

export interface FiledBuy extends InsiderBuy {
  filed: string;
}

/**
 * 只算「申報日 ≤ date」的買進。申報資料的覆蓋範圍有限（SEC 的 recent 清單），
 * date 距離覆蓋起點不足 30 天時結果不完整，回傳 null 表示「未知」而不是「沒有」。
 */
export function insiderAsOf(
  buys: FiledBuy[],
  coverageStart: string | null,
  date: string,
  nowMs: number,
): InsiderSummary | null {
  if (!coverageStart || date < addDays(coverageStart, 30)) return null;
  return summarizeInsiders(
    buys.filter((b) => b.filed <= date),
    nowMs,
  );
}

// ---------- 美股：流動性（發布時間差）----------

export function liquidityAsOf(
  walcl: Array<[string, number]>,
  tga: Array<[string, number]>,
  rrp: Array<[string, number]>,
  date: string,
): { rrp: Liquidity; net: NetLiquidity } {
  const weeklyCut = addDays(date, -2); // H.4.1 週四公布，保守起見等到週五以後
  const upTo = (series: Array<[string, number]>, cut: string) => series.filter(([d]) => d <= cut);
  const rrpUsable = upTo(rrp, date);
  return {
    rrp: liquidityFrom(rrpUsable),
    net: netLiquidityFrom(upTo(walcl, weeklyCut), upTo(tga, weeklyCut), rrpUsable),
  };
}

// ---------- 千張大戶：集保結算所開放資料（只有最新一週，需要自己逐週累積）----------

export interface TdccWeek {
  date: string;
  code: string;
  bigPct: number;
  bigPeople: number;
  bigShares: number;
}

/**
 * opendata.tdcc.com.tw/getOD.ashx?id=1-5：欄位為 資料日期、證券代號、持股分級、人數、股數、占集保庫存數比例%。
 * 持股分級 15 = 1,000,001 股（1,000 張）以上。檔案可能有 BOM，欄位名稱因此要容忍。
 */
export function parseTdccCsv(
  rows: Array<Record<string, string>>,
  codes: Set<string>,
): TdccWeek[] {
  const out: TdccWeek[] = [];
  for (const raw of rows) {
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) row[k.replace(/^\uFEFF/, "").trim()] = v;
    const level = (row["持股分級"] ?? "").trim();
    const code = (row["證券代號"] ?? "").trim();
    if (level !== "15" || !codes.has(code)) continue;
    const d = (row["資料日期"] ?? "").trim();
    if (!/^\d{8}$/.test(d)) continue;
    const pct = Number((row["占集保庫存數比例%"] ?? row["占集保庫存數比例"] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(pct)) continue;
    out.push({
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      code,
      bigPct: pct,
      bigPeople: Number((row["人數"] ?? "").replace(/,/g, "")) || 0,
      bigShares: Number((row["股數"] ?? "").replace(/,/g, "")) || 0,
    });
  }
  return out;
}

export function holderFields(info: HolderInfo | null) {
  if (!info) return null;
  const side: "concentrating" | "distributing" | "neutral" =
    info.streak >= 2 ? "concentrating" : info.streak <= -2 ? "distributing" : "neutral";
  return { bigPct: info.pct, bigChange: info.change, bigStreak: info.streak, holderSide: side };
}
