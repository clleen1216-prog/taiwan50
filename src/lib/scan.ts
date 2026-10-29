import { createServerFn } from "@tanstack/react-start";
import { BENCHMARK, UNIVERSE } from "@/lib/universe";
import { taipeiDay, taipeiWeekday } from "@/lib/format";
import { bigHolderSeries, toHolderInfo } from "@/lib/holders";
import {
  flowFrom,
  marginFrom,
  sectorRotation,
  type FlowInfo,
  type MarginInfo,
  type SectorFlow,
} from "@/lib/flows";
import {
  rollingMean,
  scoreStock,
  trailingReturn,
  type Bar,
  type CheckItem,
  type ChipSide,
  type HolderInfo,
  type HolderSide,
  type SopKind,
  type WireBar,
} from "@/lib/score";

const UA = "Mozilla/5.0 (compatible; Flagship50/1.0; +https://grok.com)";
const TTL_MS = 5 * 60 * 1000;
const CHART_BARS = 80;
const HOLDER_TTL_MS = 6 * 60 * 60 * 1000;
const HOLDER_RETRY_MS = 10 * 60 * 1000;
const HOLDER_WAIT_MS = 12000;

export interface StockRow {
  code: string;
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
  sopScore: number | null;
  sopLabel: string;
  sopKind: SopKind;
  flagshipScore: number;
  chip: ChipSide;
  chipLabel: string;
  foreign: number | null;
  trust: number | null;
  dealer: number | null;
  totalInst: number | null;
  pe: number | null;
  dividendYield: number | null;
  pb: number | null;
  ret20: number | null;
  ret60: number | null;
  rs20: number | null;
  bullStack: boolean;
  settlementPenalty: boolean;
  /** 以下三組只顯示、不計分 */
  flow: FlowInfo | null;
  margin: MarginInfo | null;
  sectorRatio: number | null;
  holderSide: HolderSide;
  holderLabel: string;
  bigPct: number | null;
  bigChange: number | null;
  bigStreak: number | null;
  notes: string[];
  checks: CheckItem[];
  bars: WireBar[];
}

export interface ScanOk {
  ok: true;
  scannedAt: number;
  sessionDate: string;
  chipDate: string | null;
  holderDate: string | null;
  flowDays: number;
  sectors: SectorFlow[];
  calendarDate: string;
  settlement: boolean;
  weekdayLabel: string;
  benchmark: { price: number; changePct: number; ret20: number | null } | null;
  rows: StockRow[];
  missing: string[];
  universeSize: number;
}

export type ScanResult = ScanOk | { ok: false; error: string };

interface ChipRow {
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
}

interface FundaRow {
  pe: number | null;
  dividendYield: number | null;
  pb: number | null;
}

let holderCache: { at: number; ok: boolean; map: Map<string, HolderInfo> } | null = null;
let holderInflight: Promise<Map<string, HolderInfo>> | null = null;
let cache: { at: number; data: ScanOk } | null = null;
let inflight: Promise<ScanResult> | null = null;

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as T;
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function r2(value: number) {
  return Math.round(value * 100) / 100;
}

export async function fetchBars(code: string, suffix = ".TW"): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=1y&interval=1d&includePrePost=false`;
  const json = await getJson<{
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>;
            high?: Array<number | null>;
            low?: Array<number | null>;
            close?: Array<number | null>;
            volume?: Array<number | null>;
          }>;
        };
      }>;
    };
  }>(url);
  const result = json.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const stamps = result?.timestamp ?? [];
  if (!quote) throw new Error("empty");
  const bars: Bar[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const t = stamps[i];
    if (o == null || h == null || l == null || c == null || t == null) continue;
    const v = quote.volume?.[i] ?? 0;
    if (v <= 0) continue;
    bars.push({ t: t * 1000, o, h, l, c, v });
  }
  return bars;
}

function shiftYmd(ymd: string, days: number) {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

interface T86Day {
  date: string | null;
  map: Map<string, ChipRow>;
}

async function fetchT86(ymd: string): Promise<T86Day | null> {
  const json = await getJson<{
    stat?: string;
    date?: string;
    fields?: string[];
    data?: string[][];
  }>(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${ymd}&selectType=ALLBUT0999`);
  if (json.stat !== "OK" || !json.fields || !json.data?.length) return null;
  const fields = json.fields;
  const at = (name: string) => fields.indexOf(name);
  const iCode = at("證券代號");
  const iForeign = at("外陸資買賣超股數(不含外資自營商)");
  const iForeignDealer = at("外資自營商買賣超股數");
  const iTrust = at("投信買賣超股數");
  const iDealer = at("自營商買賣超股數");
  const iTotal = at("三大法人買賣超股數");
  if (iCode < 0 || iForeign < 0 || iTrust < 0) return null;
  const map = new Map<string, ChipRow>();
  for (const row of json.data) {
    const code = row[iCode]?.trim();
    if (!code) continue;
    const foreignBase = num(row[iForeign]) ?? 0;
    const foreignDealer = iForeignDealer >= 0 ? (num(row[iForeignDealer]) ?? 0) : 0;
    map.set(code, {
      foreign: foreignBase + foreignDealer,
      trust: num(row[iTrust]) ?? 0,
      dealer: iDealer >= 0 ? (num(row[iDealer]) ?? 0) : 0,
      total: iTotal >= 0 ? (num(row[iTotal]) ?? 0) : 0,
    });
  }
  const raw = json.date ?? ymd;
  const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
  return { date, map };
}

async function fetchChips(): Promise<{ date: string | null; map: Map<string, ChipRow> }> {
  const start = taipeiDay(Date.now()).replace(/-/g, "");
  for (let back = 0; back < 6; back += 1) {
    const day = await fetchT86(shiftYmd(start, back));
    if (day) return day;
  }
  return { date: null, map: new Map() };
}

// 過去的交易日資料不會再變，記在記憶體裡；證交所會擋太密集的請求，所以逐日、間隔查詢。
const t86Past = new Map<string, T86Day | null>();
let historyInflight: { key: string; promise: Promise<T86Day[]> } | null = null;

function isWeekend(ymd: string) {
  const day = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))).getUTCDay();
  return day === 0 || day === 6;
}

async function buildChipHistory(latestYmd: string, need: number): Promise<T86Day[]> {
  const found: T86Day[] = [];
  for (let back = 1; back <= 14 && found.length < need; back += 1) {
    const ymd = shiftYmd(latestYmd, back);
    if (isWeekend(ymd)) continue;
    if (!t86Past.has(ymd)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        t86Past.set(ymd, await fetchT86(ymd));
      } catch {
        break; // 被限流或網路問題：用已經拿到的天數就好
      }
    }
    const day = t86Past.get(ymd);
    if (day) found.push(day);
  }
  return found.reverse();
}

function chipHistory(latestYmd: string, need = 4): Promise<T86Day[]> {
  const key = `${latestYmd}:${need}`;
  if (historyInflight?.key === key) return historyInflight.promise;
  const promise = buildChipHistory(latestYmd, need)
    .catch(() => [] as T86Day[])
    .finally(() => {
      if (historyInflight?.key === key) historyInflight = null;
    });
  historyInflight = { key, promise };
  return promise;
}

interface MarginRaw {
  marginBal: number;
  marginPrev: number;
  marginLimit: number | null;
  shortBal: number;
  shortPrev: number;
}

function pick(row: Record<string, string>, ...names: string[]): number | null {
  for (const name of names) {
    const value = num(row[name]);
    if (value != null) return value;
  }
  return null;
}

/** 證交所融資融券彙總（單位：張），只有最新一個交易日。 */
async function fetchMargin(): Promise<Map<string, MarginRaw>> {
  const rows = await getJson<Array<Record<string, string>>>(
    "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN",
  );
  const map = new Map<string, MarginRaw>();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const code = (row["股票代號"] ?? row["Code"] ?? row["證券代號"])?.trim();
    if (!code) continue;
    const marginBal = pick(row, "融資今日餘額");
    const marginPrev = pick(row, "融資前日餘額");
    const shortBal = pick(row, "融券今日餘額");
    const shortPrev = pick(row, "融券前日餘額");
    if (marginBal == null || marginPrev == null || shortBal == null || shortPrev == null) continue;
    map.set(code, {
      marginBal,
      marginPrev,
      marginLimit: pick(row, "融資限額"),
      shortBal,
      shortPrev,
    });
  }
  return map;
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const wait = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, wait]);
}

async function fetchFundamentals(): Promise<Map<string, FundaRow>> {
  const rows = await getJson<Array<Record<string, string>>>(
    "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  );
  const map = new Map<string, FundaRow>();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const code = row.Code?.trim();
    if (!code) continue;
    map.set(code, {
      pe: num(row.PEratio),
      dividendYield: num(row.DividendYield),
      pb: num(row.PBratio),
    });
  }
  return map;
}

/**
 * 集保戶股權分散表（每週五結算、週六公布）。FinMind 的 TaiwanStockHoldingSharesPer
 * 每週一筆、每個持股級距一列；持股 1,000 張 = 1,000,000 股，所以取級距下限
 * ≥ 1,000,001 股的列加總，就是「千張以上大戶」占集保庫存比例。
 * 可選環境變數 FINMIND_TOKEN 提高 FinMind 的額度；沒有也能跑。
 */
async function fetchHolders(): Promise<Map<string, HolderInfo>> {
  const start = taipeiDay(Date.now() - 60 * 24 * 3600 * 1000);
  const token = process.env.FINMIND_TOKEN?.trim();
  const out = new Map<string, HolderInfo>();
  await mapPool(UNIVERSE, 6, async (stock) => {
    try {
      const url =
        `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockHoldingSharesPer` +
        `&data_id=${stock.code}&start_date=${start}` +
        (token ? `&token=${token}` : "");
      const json = await getJson<{ status?: number; data?: Array<Record<string, string | number>> }>(url);
      if (json.status !== 200 || !Array.isArray(json.data)) return;
      const info = toHolderInfo(bigHolderSeries(json.data));
      if (info) out.set(stock.code, info);
    } catch {
      // 單檔失敗就當沒資料，不影響其他檔
    }
  });
  return out;
}

async function getHolders(): Promise<Map<string, HolderInfo>> {
  const now = Date.now();
  if (holderCache) {
    const age = now - holderCache.at;
    if (age < (holderCache.ok ? HOLDER_TTL_MS : HOLDER_RETRY_MS)) return holderCache.map;
  }
  if (!holderInflight) {
    holderInflight = fetchHolders()
      .then((map) => {
        holderCache = { at: Date.now(), ok: map.size > 0, map };
        return map;
      })
      .catch(() => new Map<string, HolderInfo>())
      .finally(() => {
        holderInflight = null;
      });
  }
  return holderInflight;
}

async function holdersWithin(ms: number): Promise<Map<string, HolderInfo>> {
  const empty = new Map<string, HolderInfo>();
  const wait = new Promise<Map<string, HolderInfo>>((resolve) => setTimeout(() => resolve(empty), ms));
  // 超時就先用空的，抓取會在背景繼續並寫入快取，下一輪掃描就用得到
  return Promise.race([getHolders(), wait]);
}

function toRow(
  meta: { code: string; name: string; sector: string },
  bars: Bar[],
  chip: ChipRow | undefined,
  funda: FundaRow | undefined,
  holders: HolderInfo | undefined,
  flow: FlowInfo | null,
  marginRaw: MarginRaw | undefined,
  settlement: boolean,
  benchRet20: number | null,
): StockRow | null {
  if (bars.length < 60) return null;
  const closes = bars.map((bar) => bar.c);
  const volumes = bars.map((bar) => bar.v);
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
  if (
    ma5 == null ||
    ma10 == null ||
    ma20 == null ||
    ma60 == null ||
    volMa20 == null ||
    !bar ||
    !prev
  ) {
    return null;
  }

  const ret20raw = trailingReturn(closes, 20);
  const ret60raw = trailingReturn(closes, 60);
  const scored = scoreStock({
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
    foreign: chip ? chip.foreign : null,
    trust: chip ? chip.trust : null,
    settlement,
    ret20: ret20raw,
    benchRet20,
    holders: holders ?? null,
  });

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
    code: meta.code,
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
    spreadPct: scored.spreadPct,
    volRatio: scored.volRatio,
    upperShadow: scored.upperShadow,
    bearish: scored.bearish,
    inGate: scored.inGate,
    tight: scored.tight,
    sopScore: scored.sopScore,
    sopLabel: scored.sopLabel,
    sopKind: scored.sopKind,
    flagshipScore: scored.flagshipScore,
    chip: scored.chip,
    chipLabel: scored.chipLabel,
    foreign: chip ? chip.foreign : null,
    trust: chip ? chip.trust : null,
    dealer: chip ? chip.dealer : null,
    totalInst: chip ? chip.total : null,
    pe: funda?.pe ?? null,
    dividendYield: funda?.dividendYield ?? null,
    pb: funda?.pb ?? null,
    ret20: ret20raw == null ? null : r2(ret20raw),
    ret60: ret60raw == null ? null : r2(ret60raw),
    rs20: scored.rs20,
    bullStack: scored.bullStack,
    settlementPenalty: scored.settlementPenalty,
    flow,
    margin: marginRaw ? marginFrom(marginRaw, r2((change / prev.c) * 100)) : null,
    sectorRatio: null,
    holderSide: scored.holderSide,
    holderLabel: scored.holderLabel,
    bigPct: holders ? holders.pct : null,
    bigChange: holders ? holders.change : null,
    bigStreak: holders ? holders.streak : null,
    notes: scored.notes,
    checks: scored.checks,
    bars: wire,
  };
}

async function buildScan(): Promise<ScanResult> {
  const scannedAt = Date.now();
  const weekday = taipeiWeekday(scannedAt);
  try {
    const [chipResult, fundaResult, holderMap, marginMap, benchBars, charts] = await Promise.all([
      fetchChips().catch(() => ({ date: null, map: new Map<string, ChipRow>() })),
      fetchFundamentals().catch(() => new Map<string, FundaRow>()),
      holdersWithin(HOLDER_WAIT_MS),
      fetchMargin().catch(() => new Map<string, MarginRaw>()),
      fetchBars(BENCHMARK.code).catch(() => [] as Bar[]),
      mapPool(UNIVERSE, 8, async (stock) => {
        try {
          return { stock, bars: await fetchBars(stock.code), error: null as string | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "失敗";
          return { stock, bars: [] as Bar[], error: message };
        }
      }),
    ]);

    // 近幾個交易日的三大法人：給「連續買賣超」用。逾時就先略過，背景會繼續補進快取。
    const history = chipResult.date
      ? await within(chipHistory(chipResult.date.replace(/-/g, "")), 12000, [] as T86Day[])
      : ([] as T86Day[]);
    const flowDays = history.length + (chipResult.map.size > 0 ? 1 : 0);
    const flowOf = (code: string): FlowInfo | null => {
      const today = chipResult.map.get(code);
      if (!today || history.length === 0) return null;
      const days = [...history.map((d) => d.map.get(code)), today];
      return flowFrom(
        days.map((d) => d?.foreign ?? 0),
        days.map((d) => d?.trust ?? 0),
      );
    };

    const benchCloses = benchBars.map((bar) => bar.c);
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

    const missing: string[] = [];
    const rows: StockRow[] = [];
    let sessionMs = 0;
    for (const item of charts) {
      if (item.error || item.bars.length < 60) {
        missing.push(item.stock.code);
        continue;
      }
      const row = toRow(
        item.stock,
        item.bars,
        chipResult.map.get(item.stock.code),
        fundaResult.get(item.stock.code),
        holderMap.get(item.stock.code),
        flowOf(item.stock.code),
        marginMap.get(item.stock.code),
        weekday.isWednesday,
        benchRet20,
      );
      if (!row) {
        missing.push(item.stock.code);
        continue;
      }
      rows.push(row);
      const lastBar = item.bars[item.bars.length - 1];
      if (lastBar && lastBar.t > sessionMs) sessionMs = lastBar.t;
    }

    if (rows.length === 0) {
      return { ok: false, error: "報價暫時取不到，稍後再掃一次。" };
    }

    const sectors = sectorRotation(
      charts
        .filter((item) => item.bars.length >= 20 && !item.error)
        .map((item) => ({
          sector: item.stock.sector,
          days: item.bars.slice(-20).map((bar): [string, number] => [taipeiDay(bar.t), bar.c * bar.v]),
        })),
    );
    const ratioBySector = new Map(sectors.map((entry) => [entry.sector, entry.ratio]));
    for (const row of rows) row.sectorRatio = ratioBySector.get(row.sector) ?? null;

    rows.sort((a, b) => b.flagshipScore - a.flagshipScore || a.code.localeCompare(b.code));

    return {
      ok: true,
      scannedAt,
      sessionDate: sessionMs ? taipeiDay(sessionMs) : taipeiDay(scannedAt),
      chipDate: chipResult.date,
      holderDate: [...holderMap.values()].reduce<string | null>(
        (latest, info) => (latest == null || info.date > latest ? info.date : latest),
        null,
      ),
      flowDays,
      sectors,
      calendarDate: taipeiDay(scannedAt),
      settlement: weekday.isWednesday,
      weekdayLabel: weekday.label,
      benchmark,
      rows,
      missing,
      universeSize: UNIVERSE.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "掃描失敗";
    return { ok: false, error: message };
  }
}

async function loadScan(force: boolean): Promise<ScanResult> {
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

export const scanMarket = createServerFn({ method: "GET" })
  .validator((input: { force?: boolean } | undefined) => ({
    force: Boolean(input?.force),
  }))
  .handler(async ({ data }) => loadScan(data.force));
