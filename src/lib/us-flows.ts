/**
 * 美股資金流類特徵的純函式（不碰網路、不碰檔案，方便單元測試）：
 * 1) FINRA 每日空單成交量  2) 選擇權成交量／未平倉的 Put/Call  3) SEC 13F 機構持股季變化
 */

// ---------- 1) FINRA 每日空單量 ----------

export interface ShortVolRow {
  date: string; // YYYY-MM-DD
  symbol: string;
  shortVol: number;
  exemptVol: number;
  totalVol: number;
}

/** 檔案格式：Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market，最後一行常是筆數，要略過 */
export function parseFinraShortVol(text: string, wanted: Set<string>): ShortVolRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0]!.split("|").map((h) => h.trim().toLowerCase());
  const at = (name: string) => head.indexOf(name);
  const iDate = at("date");
  const iSym = at("symbol");
  const iShort = at("shortvolume");
  const iEx = at("shortexemptvolume");
  const iTot = at("totalvolume");
  if ([iDate, iSym, iShort, iTot].some((i) => i < 0)) throw new Error(`FINRA 欄位不符：${lines[0]}`);
  const out: ShortVolRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split("|");
    const symbol = (f[iSym] ?? "").trim().toUpperCase();
    if (!wanted.has(symbol)) continue;
    const d = (f[iDate] ?? "").trim();
    const date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
    const shortVol = Number(f[iShort]);
    const totalVol = Number(f[iTot]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(shortVol) || !Number.isFinite(totalVol) || totalVol <= 0) continue;
    out.push({ date, symbol, shortVol, exemptVol: iEx >= 0 ? Number(f[iEx]) || 0 : 0, totalVol });
  }
  return out;
}

/** FINRA 的 BRK.B 之類用句點，我們用連字號 */
export function finraSymbol(symbol: string) {
  return symbol.replace("-", ".");
}

// ---------- 2) 選擇權 Put/Call ----------

export interface OptionLeg {
  volume?: number | null;
  openInterest?: number | null;
}

export interface OptionTotals {
  callVol: number;
  putVol: number;
  callOi: number;
  putOi: number;
  expiries: number;
}

export function addOptionTotals(acc: OptionTotals, calls: OptionLeg[], puts: OptionLeg[]): OptionTotals {
  const sum = (legs: OptionLeg[], key: "volume" | "openInterest") =>
    legs.reduce((s, l) => s + (Number.isFinite(Number(l[key])) ? Number(l[key]) : 0), 0);
  return {
    callVol: acc.callVol + sum(calls, "volume"),
    putVol: acc.putVol + sum(puts, "volume"),
    callOi: acc.callOi + sum(calls, "openInterest"),
    putOi: acc.putOi + sum(puts, "openInterest"),
    expiries: acc.expiries + 1,
  };
}

export const EMPTY_OPTIONS: OptionTotals = { callVol: 0, putVol: 0, callOi: 0, putOi: 0, expiries: 0 };

/** 取最近的幾個到期日（45 天內，最多 4 個），避免遠月流動性稀疏稀釋比值 */
export function pickExpiries(expirations: number[], nowMs: number, maxDays = 45, maxCount = 4): number[] {
  const limit = nowMs / 1000 + maxDays * 86400;
  return expirations
    .filter((e) => e * 1000 >= nowMs - 86400_000 && e <= limit)
    .sort((a, b) => a - b)
    .slice(0, maxCount);
}

export function ratio(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
}

// ---------- 3) 13F ----------

export interface Filing {
  accession: string;
  filedOn: string; // YYYY-MM-DD
  type: string;
  quarterEnd: string;
}

export interface InstHolding {
  accession: string;
  cusip: string;
  name: string;
  title: string;
  valueUsd: number;
  shares: number;
  shareType: string;
  putCall: string;
}

export interface NameRule {
  symbol: string;
  name: RegExp;
  title?: RegExp;
}

/** SEC 日期格式可能是 31-DEC-2025 或 2025-12-31 */
export function normalizeSecDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return null;
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const mi = months.indexOf(m[2]!.toUpperCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

export function addDaysIso(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** 13F 法定期限是季末後 45 天，遇週末或假日順延（例如 2026-02-14 是週六又遇總統日，實際到 2/17）。
 *  所以收 48 天內送出的申報，從第 49 天起才算「已知」。 */
export const FILING_GRACE_DAYS = 48;
export function holdingsUsableFrom(quarterEnd: string) {
  return addDaysIso(quarterEnd, FILING_GRACE_DAYS + 1);
}

export function filedInTime(f: Filing) {
  return f.type === "13F-HR" && f.filedOn <= addDaysIso(f.quarterEnd, FILING_GRACE_DAYS);
}

export function matchRule(rules: NameRule[], name: string, title: string): string | null {
  const n = name.toUpperCase();
  const t = title.toUpperCase();
  for (const r of rules) {
    if (r.name.test(n) && (!r.title || r.title.test(t))) return r.symbol;
  }
  return null;
}

export interface CusipTotals {
  /** key = `${symbol}|${cusip}` */
  value: Map<string, number>;
}

export function pickCusips(totals: Map<string, number>): { chosen: Map<string, string>; alternates: Map<string, string[]> } {
  const bySymbol = new Map<string, Array<[string, number]>>();
  for (const [key, value] of totals) {
    const [symbol, cusip] = key.split("|") as [string, string];
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), [cusip, value]]);
  }
  const chosen = new Map<string, string>();
  const alternates = new Map<string, string[]>();
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => b[1] - a[1]);
    chosen.set(symbol, list[0]![0]);
    alternates.set(symbol, list.slice(1, 4).map(([c, v]) => `${c}(${Math.round(v / 1e6)}M)`));
  }
  return { chosen, alternates };
}

export interface QuarterAgg {
  shares: number;
  valueUsd: number;
  holders: Set<string>;
}

export interface QuarterRow {
  quarter_end: string;
  usable_from: string;
  symbol: string;
  cusip: string;
  shares: number;
  value_usd: number;
  holders: number;
  filings: number;
}

export function changePct(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || !(before > 0)) return null;
  return Math.round(((now - before) / before) * 10000) / 100;
}

/** 某一天可用的最新一季（usable_from <= 該日），回傳該季與前一季 */
export function latestQuarterAsOf<T extends { quarter_end: string; usable_from: string }>(rows: T[], date: string): { cur: T; prev: T | null } | null {
  const usable = rows.filter((r) => r.usable_from <= date).sort((a, b) => a.quarter_end.localeCompare(b.quarter_end));
  const cur = usable[usable.length - 1];
  if (!cur) return null;
  return { cur, prev: usable[usable.length - 2] ?? null };
}

// ---------- 空單比特徵（給驗證與之後的 UI 用） ----------

export interface ShortFeatures {
  shortRatio: number;
  shortRatio5d: number | null;
  shortZ60: number | null;
}

/** series 依日期遞增；用到當天為止的資料，不偷看後面 */
export function shortFeaturesAt(series: Array<{ shortVol: number; totalVol: number }>, index: number): ShortFeatures | null {
  const today = series[index];
  if (!today || today.totalVol <= 0) return null;
  const r = (x: { shortVol: number; totalVol: number }) => x.shortVol / x.totalVol;
  const last5 = series.slice(Math.max(0, index - 4), index + 1);
  const hist = series.slice(Math.max(0, index - 59), index + 1).filter((x) => x.totalVol > 0).map(r);
  let z: number | null = null;
  if (hist.length >= 30) {
    const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / (hist.length - 1));
    z = sd > 0 ? Math.round(((r(today) - mean) / sd) * 100) / 100 : null;
  }
  const five = last5.reduce((s, x) => s + x.shortVol, 0) / Math.max(1, last5.reduce((s, x) => s + x.totalVol, 0));
  return {
    shortRatio: Math.round(r(today) * 1000) / 1000,
    shortRatio5d: last5.length === 5 ? Math.round(five * 1000) / 1000 : null,
    shortZ60: z,
  };
}

export interface CusipAgg {
  shares: number;
  valueUsd: number;
  holders: Set<string>;
}

/** 同一檔同一季若有多個 CUSIP（換股票代碼、分割後換 CUSIP、填錯），取該季市值最大的那個 */
export function dominantCusips(agg: Map<string, CusipAgg>): Map<string, { cusip: string } & CusipAgg> {
  const best = new Map<string, { cusip: string } & CusipAgg>();
  for (const [key, a] of agg) {
    const [quarter, symbol, cusip] = key.split("|") as [string, string, string];
    const k = `${quarter}|${symbol}`;
    const cur = best.get(k);
    if (!cur || a.valueUsd > cur.valueUsd) best.set(k, { cusip, ...a });
  }
  return best;
}
