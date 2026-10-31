import { US_BENCHMARK, US_SECTOR_ETFS, US_UNIVERSE, type UsStock } from "@/lib/us-universe";
import { etfFlow, type EtfFlow } from "@/lib/flows";
import { fetchBars, mapPool, r2, waitMs } from "@/lib/scan-core";
import {
  rollingMean,
  scoreStock,
  trailingReturn,
  type Bar,
  type CheckItem,
  type SopKind,
  type WireBar,
} from "@/lib/score";
import {
  daysUntil,
  expectedMoveFrom,
  liquidityFrom,
  netLiquidityFrom,
  parseForm4Purchases,
  pickExpiry,
  parseFredCsv,
  summarizeInsiders,
  type InsiderBuy,
  type InsiderSummary,
  type Liquidity,
  type NetLiquidity,
  type OptionQuote,
} from "@/lib/us-extra";

const TTL_MS = 5 * 60 * 1000;
const SLOW_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const SLOW_WAIT_MS = 15000;
const CHART_BARS = 80;
const INSIDER_BONUS = 20;
const EARNINGS_PENALTY_SOP = 40;
const EARNINGS_PENALTY_FLAGSHIP = 30;

const BROWSER_UA = "Mozilla/5.0 (compatible; Flagship50/1.0)";
/** SEC 要求 User-Agent 標明用途與聯絡方式；可用環境變數 SEC_USER_AGENT 覆寫。 */
export function secUa() {
  return (
    process.env.SEC_USER_AGENT?.trim() ||
    "Flagship50 personal research app (github.com/clleen1216-prog/taiwan50)"
  );
}

export interface UsRow {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  spreadPct: number;
  volRatio: number;
  upperShadow: number;
  bearish: boolean;
  inGate: boolean;
  tight: boolean;
  bullStack: boolean;
  sopScore: number | null;
  sopLabel: string;
  sopKind: SopKind;
  flagshipScore: number;
  ret20: number | null;
  rs20: number | null;
  /** 距離財報幾天；null = 抓不到財報日（不是「安全」） */
  earningsDays: number | null;
  earningsNear: boolean;
  /** 財報前後市場預期波動（ATM 跨式 ÷ 現價），只顯示不計分 */
  impliedMovePct: number | null;
  impliedIv: number | null;
  impliedExpiry: string | null;
  insiderApplicable: boolean;
  insiderKnown: boolean;
  insiderBought: boolean;
  insiderNote: string;
  insiderUsd: number;
  insiderBonus: boolean;
  notes: string[];
  checks: CheckItem[];
  bars: WireBar[];
}

export interface UsScanOk {
  ok: true;
  scannedAt: number;
  sessionDate: string;
  benchmark: { price: number; changePct: number; ret20: number | null } | null;
  liquidity: Liquidity;
  netLiquidity: NetLiquidity;
  etfs: EtfFlow[];
  earningsKnown: number;
  insiderKnown: number;
  rows: UsRow[];
  missing: string[];
  universeSize: number;
}

export type UsScanResult = UsScanOk | { ok: false; error: string };

// ---------- 通用抓取 ----------

export async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

function sessionDay(ms: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

// ---------- 總經流動性 (FRED ON RRP) ----------

export async function fetchFred(id: string) {
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {
    "User-Agent": BROWSER_UA,
  });
  return parseFredCsv(text);
}

/** ON RRP（每日）與淨流動性（聯準會資產 − TGA − RRP，每週）。其中一項失敗不影響另一項。 */
async function fetchLiquidities(): Promise<{ rrp: Liquidity; net: NetLiquidity }> {
  const [rrpSeries, walcl, tga] = await Promise.all([
    fetchFred("RRPONTSYD").catch(() => [] as Array<[string, number]>),
    fetchFred("WALCL").catch(() => [] as Array<[string, number]>),
    fetchFred("WTREGEN").catch(() => [] as Array<[string, number]>),
  ]);
  return {
    rrp: liquidityFrom(rrpSeries),
    net: netLiquidityFrom(walcl, tga, rrpSeries),
  };
}

// ---------- 財報日 (Yahoo quoteSummary, 需要 crumb) ----------

let crumbCache: { at: number; crumb: string; cookie: string } | null = null;

async function yahooSession() {
  if (crumbCache && Date.now() - crumbCache.at < 60 * 60 * 1000) return crumbCache;
  const seed = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  const cookie = seed.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("no cookie");
  const crumb = await fetchText("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    "User-Agent": BROWSER_UA,
    Cookie: cookie,
  });
  if (!crumb || crumb.includes("<")) throw new Error("bad crumb");
  crumbCache = { at: Date.now(), crumb, cookie };
  return crumbCache;
}

async function fetchEarningsMs(symbol: string, now: number): Promise<number | null> {
  const { crumb, cookie } = await yahooSession();
  const text = await fetchText(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`,
    { "User-Agent": BROWSER_UA, Cookie: cookie },
  );
  const json = JSON.parse(text) as {
    quoteSummary?: {
      result?: Array<{ calendarEvents?: { earnings?: { earningsDate?: Array<{ raw?: number }> } } }>;
    };
  };
  const dates = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? [];
  const future = dates
    .map((d) => (d.raw ? d.raw * 1000 : NaN))
    .filter((ms) => Number.isFinite(ms) && daysUntil(ms, now) >= 0)
    .sort((a, b) => a - b);
  return future[0] ?? null;
}

// ---------- 財報週預期波動 (Yahoo 選擇權鏈) ----------

interface ChainResult {
  expirationDates?: number[];
  quote?: { regularMarketPrice?: number };
  options?: Array<{ calls?: OptionQuote[]; puts?: OptionQuote[] }>;
}

async function fetchChain(symbol: string, dateSec?: number): Promise<ChainResult | null> {
  const { crumb, cookie } = await yahooSession();
  const text = await fetchText(
    `https://query2.finance.yahoo.com/v7/finance/options/${symbol}?crumb=${encodeURIComponent(crumb)}${dateSec ? `&date=${dateSec}` : ""}`,
    { "User-Agent": BROWSER_UA, Cookie: cookie },
  );
  const json = JSON.parse(text) as { optionChain?: { result?: ChainResult[] } };
  return json.optionChain?.result?.[0] ?? null;
}

const impliedCache = new Map<string, { at: number; value: { movePct: number; iv: number | null; expiry: string } | null }>();

async function fetchImpliedMove(symbol: string, earningsMs: number, spotFallback: number) {
  const hit = impliedCache.get(symbol);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.value;
  let value: { movePct: number; iv: number | null; expiry: string } | null = null;
  try {
    const first = await fetchChain(symbol);
    const expiry = pickExpiry(first?.expirationDates ?? [], earningsMs);
    if (expiry) {
      const chain = await fetchChain(symbol, expiry);
      const opt = chain?.options?.[0];
      const spot = chain?.quote?.regularMarketPrice ?? first?.quote?.regularMarketPrice ?? spotFallback;
      const move = opt ? expectedMoveFrom(opt.calls ?? [], opt.puts ?? [], spot) : null;
      if (move) {
        value = {
          movePct: move.movePct,
          iv: move.iv,
          expiry: new Date(expiry * 1000).toISOString().slice(0, 10),
        };
      }
    }
  } catch {
    value = null;
  }
  impliedCache.set(symbol, { at: Date.now(), value });
  return value;
}

// ---------- 內部人 Form 4 (SEC EDGAR) ----------

export type InsiderResult = { status: "ok"; summary: InsiderSummary } | { status: "fail" };

let cikCache: { at: number; map: Map<string, string> } | null = null;

// SEC 每秒最多約 10 次請求，超過會被暫時封鎖。所有 SEC 請求共用一個閘門（約每秒 7 次），
// 遇到 429/403/503 會等待後重試，避免默默失敗。
let secNextSlot = 0;
export async function secFetch(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const wait = Math.max(0, secNextSlot - now);
    secNextSlot = Math.max(now, secNextSlot) + 140;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fetchText(url, { "User-Agent": secUa() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^(429|403|503)$/.test(message) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 15_000 : 45_000));
      secNextSlot = Math.max(secNextSlot, Date.now());
    }
  }
  throw new Error("unreachable");
}

export async function cikOf(symbol: string): Promise<string | null> {
  if (!cikCache || Date.now() - cikCache.at > 24 * 60 * 60 * 1000) {
    const text = await secFetch("https://www.sec.gov/files/company_tickers.json");
    const json = JSON.parse(text) as Record<string, { cik_str: number; ticker: string }>;
    const map = new Map<string, string>();
    for (const item of Object.values(json)) map.set(item.ticker.toUpperCase(), String(item.cik_str));
    cikCache = { at: Date.now(), map };
  }
  return cikCache.map.get(symbol) ?? null;
}

async function fetchInsider(symbol: string, now: number): Promise<InsiderResult> {
  try {
    const cik = await cikOf(symbol);
    if (!cik) return { status: "fail" };
    const sub = JSON.parse(
      await secFetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`),
    ) as {
      filings?: {
        recent?: {
          form?: string[];
          filingDate?: string[];
          accessionNumber?: string[];
          primaryDocument?: string[];
        };
      };
    };
    const recent = sub.filings?.recent;
    if (!recent?.form) return { status: "fail" };
    const cutoff = now - 35 * 86_400_000;
    const picks: Array<{ acc: string; doc: string }> = [];
    for (let i = 0; i < recent.form.length && picks.length < 20; i += 1) {
      if (recent.form[i] !== "4") continue;
      if (Date.parse(recent.filingDate?.[i] ?? "") < cutoff) continue;
      const acc = recent.accessionNumber?.[i];
      const doc = recent.primaryDocument?.[i];
      if (acc && doc) picks.push({ acc, doc });
    }
    const buys: InsiderBuy[] = [];
    await mapPool(picks, 4, async ({ acc, doc }) => {
      try {
        const file = doc.replace(/^xslF345X\d+\//, "");
        const xml = await secFetch(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${file}`);
        buys.push(...parseForm4Purchases(xml));
      } catch {
        // 單份申報讀不到就略過
      }
    });
    return { status: "ok", summary: summarizeInsiders(buys, now) };
  } catch {
    return { status: "fail" };
  }
}

// ---------- 慢速資料 (財報日 / 內部人)，快取 6 小時 ----------

export interface SlowData {
  earnings: Map<string, number | null>;
  insiders: Map<string, InsiderResult>;
}

let slowCache: { at: number; ok: boolean; data: SlowData } | null = null;
let slowInflight: Promise<SlowData> | null = null;

async function buildSlow(): Promise<SlowData> {
  const now = Date.now();
  const earnings = new Map<string, number | null>();
  const insiders = new Map<string, InsiderResult>();
  await Promise.all([
    mapPool(US_UNIVERSE, 4, async (stock) => {
      try {
        earnings.set(stock.symbol, await fetchEarningsMs(stock.symbol, now));
      } catch {
        // 不寫入 = 未知
      }
    }),
    mapPool(
      US_UNIVERSE.filter((stock) => !stock.foreignIssuer),
      3,
      async (stock) => {
        insiders.set(stock.symbol, await fetchInsider(stock.symbol, now));
      },
    ),
  ]);
  return { earnings, insiders };
}

async function getSlow(): Promise<SlowData> {
  if (slowCache) {
    const ttl = slowCache.ok ? SLOW_TTL_MS : RETRY_MS;
    if (Date.now() - slowCache.at < ttl) return slowCache.data;
  }
  if (!slowInflight) {
    slowInflight = buildSlow()
      .then((data) => {
        const ok = data.earnings.size > 0 || [...data.insiders.values()].some((r) => r.status === "ok");
        slowCache = { at: Date.now(), ok, data };
        return data;
      })
      .catch(() => ({ earnings: new Map(), insiders: new Map() }) as SlowData)
      .finally(() => {
        slowInflight = null;
      });
  }
  return slowInflight;
}

async function slowWithin(ms: number): Promise<SlowData> {
  const empty: SlowData = { earnings: new Map(), insiders: new Map() };
  const wait = new Promise<SlowData>((resolve) => setTimeout(() => resolve(empty), ms));
  return Promise.race([getSlow(), wait]);
}

// ---------- 組成一列 ----------

export function toUsRow(
  meta: UsStock,
  bars: Bar[],
  benchRet20: number | null,
  slow: SlowData,
  now: number,
): UsRow | null {
  if (bars.length < 60) return null;
  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v);
  const last = bars.length - 1;
  const ma5s = rollingMean(closes, 5);
  const ma10s = rollingMean(closes, 10);
  const ma20s = rollingMean(closes, 20);
  const ma60s = rollingMean(closes, 60);
  const vol20s = rollingMean(volumes, 20);
  const ma5 = ma5s[last];
  const ma10 = ma10s[last];
  const ma20 = ma20s[last];
  const ma60 = ma60s[last];
  const volMa20 = vol20s[last];
  const bar = bars[last];
  const prev = bars[last - 1];
  if (ma5 == null || ma10 == null || ma20 == null || ma60 == null || volMa20 == null || !bar || !prev) {
    return null;
  }

  const ret20raw = trailingReturn(closes, 20);
  const base = scoreStock({
    close: bar.c,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    volume: bar.v,
    ma5,
    ma10,
    ma20,
    ma60,
    volMa20,
    foreign: null,
    trust: null,
    settlement: false,
    ret20: ret20raw,
    benchRet20,
    holders: null,
    benchName: US_BENCHMARK.symbol,
  });

  // 財報週：距離 0~3 天
  const earningsMs = slow.earnings.get(meta.symbol);
  const earningsKnown = slow.earnings.has(meta.symbol);
  const earningsDays = earningsMs == null ? null : daysUntil(earningsMs, now);
  const earningsNear = earningsDays != null && earningsDays >= 0 && earningsDays <= 3;

  // 內部人
  const insiderResult = slow.insiders.get(meta.symbol);
  const insiderApplicable = !meta.foreignIssuer;
  const insiderKnown = insiderApplicable && insiderResult?.status === "ok";
  const summary = insiderResult?.status === "ok" ? insiderResult.summary : null;
  const insiderBought = summary?.hasBought ?? false;
  const insiderBonus = base.inGate && base.sopKind === "breakout" && insiderBought;

  let sop = base.sopScore;
  let flagship = base.flagshipScore;
  let sopLabel = base.sopLabel;
  const notes = [...base.notes];

  if (insiderBonus) {
    if (sop != null) sop += INSIDER_BONUS;
    flagship += INSIDER_BONUS;
    notes.unshift(`${summary!.note}，糾結突破又有內部人買進（+${INSIDER_BONUS}）`);
  } else if (insiderBought) {
    notes.unshift(`${summary!.note}，但還沒糾結突破，不加分`);
  }

  if (earningsNear) {
    if (sop != null) sop -= EARNINGS_PENALTY_SOP;
    flagship -= EARNINGS_PENALTY_FLAGSHIP;
    sopLabel = "財報週 · 暫停追價";
    notes.unshift(`${earningsDays === 0 ? "今天" : `${earningsDays} 天後`}公布財報，嚴防 IV Crush（−${EARNINGS_PENALTY_SOP}）`);
  } else if (!earningsKnown) {
    notes.push("財報日這輪沒抓到，無法判斷財報風險");
  }
  flagship = Math.max(0, Math.min(100, Math.round(flagship)));

  const checks: CheckItem[] = base.checks
    .filter((c) => !["外資買超", "投信買超", "結算日不追突破"].includes(c.label))
    .concat([
      {
        label: "財報週防禦",
        pass: earningsKnown && !earningsNear,
        detail: !earningsKnown
          ? "財報日未知"
          : earningsDays == null
            ? "近期無財報"
            : earningsNear
              ? `倒數 ${earningsDays} 天`
              : `${earningsDays} 天後`,
      },
      {
        label: "內部人公開市場買進",
        pass: insiderBought,
        detail: !insiderApplicable
          ? "外國發行人不適用"
          : !insiderKnown
            ? "未取得"
            : insiderBought
              ? `$${Math.round((summary?.totalUsd ?? 0) / 1000)}K`
              : "無",
      },
    ]);

  const wire: WireBar[] = [];
  for (let i = Math.max(0, bars.length - CHART_BARS); i < bars.length; i += 1) {
    const item = bars[i];
    const m20 = ma20s[i];
    const m60 = ma60s[i];
    if (!item || m20 == null || m60 == null) continue;
    wire.push([item.t, r2(item.o), r2(item.h), r2(item.l), r2(item.c), Math.round(item.v), r2(m20), r2(m60)]);
  }

  const change = bar.c - prev.c;
  return {
    symbol: meta.symbol,
    name: meta.name,
    sector: meta.sector,
    price: r2(bar.c),
    change: r2(change),
    changePct: r2((change / prev.c) * 100),
    open: r2(bar.o),
    high: r2(bar.h),
    low: r2(bar.l),
    volume: Math.round(bar.v),
    ma5: r2(ma5),
    ma10: r2(ma10),
    ma20: r2(ma20),
    ma60: r2(ma60),
    spreadPct: base.spreadPct,
    volRatio: base.volRatio,
    upperShadow: base.upperShadow,
    bearish: base.bearish,
    inGate: base.inGate,
    tight: base.tight,
    bullStack: base.bullStack,
    sopScore: sop,
    sopLabel,
    sopKind: base.sopKind,
    flagshipScore: flagship,
    ret20: ret20raw == null ? null : r2(ret20raw),
    rs20: base.rs20,
    earningsDays,
    earningsNear,
    impliedMovePct: null,
    impliedIv: null,
    impliedExpiry: null,
    insiderApplicable,
    insiderKnown,
    insiderBought,
    insiderNote: !insiderApplicable ? "外國發行人，不申報 Form 4" : (summary?.note ?? "內部人資料未取得"),
    insiderUsd: summary?.totalUsd ?? 0,
    insiderBonus,
    notes: notes.slice(0, 7),
    checks,
    bars: wire,
  };
}

let cache: { at: number; data: UsScanOk } | null = null;
let inflight: Promise<UsScanResult> | null = null;

async function buildScan(): Promise<UsScanResult> {
  const scannedAt = Date.now();
  try {
    const [liquidities, slow, etfBars, benchBars, charts] = await Promise.all([
      fetchLiquidities().catch(() => ({ rrp: liquidityFrom([]), net: netLiquidityFrom([], [], []) })),
      slowWithin(waitMs(SLOW_WAIT_MS)),
      mapPool([...US_SECTOR_ETFS], 4, async (etf) => ({
        etf,
        bars: await fetchBars(etf.symbol, "").catch(() => [] as Bar[]),
      })),
      fetchBars(US_BENCHMARK.symbol, "").catch(() => [] as Bar[]),
      mapPool(US_UNIVERSE, 6, async (stock) => {
        try {
          return { stock, bars: await fetchBars(stock.symbol, ""), error: false };
        } catch {
          return { stock, bars: [] as Bar[], error: true };
        }
      }),
    ]);

    const benchCloses = benchBars.map((b) => b.c);
    const benchRet20 = benchCloses.length > 21 ? trailingReturn(benchCloses, 20) : null;
    const benchLast = benchBars[benchBars.length - 1];
    const benchPrev = benchBars[benchBars.length - 2];
    const benchmark =
      benchLast && benchPrev
        ? {
            price: r2(benchLast.c),
            changePct: r2(((benchLast.c - benchPrev.c) / benchPrev.c) * 100),
            ret20: benchRet20 == null ? null : r2(benchRet20),
          }
        : null;

    const etfs = etfBars
      .filter((item) => item.bars.length >= 21 && benchBars.length >= 21)
      .map((item) => etfFlow(item.etf, item.bars, benchBars))
      .sort((a, b) => (b.rel20 ?? -999) - (a.rel20 ?? -999));

    const rows: UsRow[] = [];
    const missing: string[] = [];
    let sessionMs = 0;
    for (const item of charts) {
      const row = item.error ? null : toUsRow(item.stock, item.bars, benchRet20, slow, scannedAt);
      if (!row) {
        missing.push(item.stock.symbol);
        continue;
      }
      rows.push(row);
      const lastBar = item.bars[item.bars.length - 1];
      if (lastBar && lastBar.t > sessionMs) sessionMs = lastBar.t;
    }
    if (rows.length === 0) return { ok: false, error: "美股報價暫時取不到，稍後再掃一次。" };

    // 財報 7 天內的才查選擇權（兩次請求 / 檔），逾時就先不顯示，背景會補進快取
    const targets = rows.filter((r) => r.earningsDays != null && r.earningsDays >= 0 && r.earningsDays <= 7);
    await Promise.race([
      mapPool(targets, 3, async (row) => {
        const earningsMs = slow.earnings.get(row.symbol);
        if (earningsMs == null) return;
        const move = await fetchImpliedMove(row.symbol, earningsMs, row.price);
        if (move) {
          row.impliedMovePct = move.movePct;
          row.impliedIv = move.iv;
          row.impliedExpiry = move.expiry;
        }
      }),
      new Promise((resolve) => setTimeout(resolve, waitMs(10000))),
    ]);

    rows.sort((a, b) => b.flagshipScore - a.flagshipScore || a.symbol.localeCompare(b.symbol));
    return {
      ok: true,
      scannedAt,
      sessionDate: sessionMs ? sessionDay(sessionMs) : sessionDay(scannedAt),
      benchmark,
      liquidity: liquidities.rrp,
      netLiquidity: liquidities.net,
      etfs,
      earningsKnown: slow.earnings.size,
      insiderKnown: [...slow.insiders.values()].filter((r) => r.status === "ok").length,
      rows,
      missing,
      universeSize: US_UNIVERSE.length,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "掃描失敗" };
  }
}

export async function loadScan(force: boolean): Promise<UsScanResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!force && inflight) return inflight;
  inflight = buildScan()
    .then((data) => {
      if (data.ok) cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
