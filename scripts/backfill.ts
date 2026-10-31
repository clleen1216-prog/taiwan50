/**
 * 歷史回填：用歷史資料重建過去每個交易日的特徵列（跟每日快照相同欄位），
 * 寫到 data/history/ 底下，不會碰每日快照（data/tw、data/us），兩者來源分開，方便日後比對。
 *
 * 用法：npx tsx --tsconfig tsconfig.json scripts/backfill.ts tw|us
 * 環境變數：OUT_DIR（預設 ./data）、YEARS（預設 3）、MAX_MINUTES（預設 300，到時間會存檔並正常結束，可重跑續做）
 *
 * 只用「當天收盤後已公開」的資料（見 src/lib/backfill.ts），盡量避免未來資訊洩漏。
 * 已知限制：名單是現在的成分（有倖存者偏誤）；選擇權預期波動、台股本益比無法回填。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchBars, fetchT86, getJson, mapPool, toRow, type ChipRow, type MarginRaw } from "../src/lib/scan-core";
import { cikOf, fetchFred, secFetch, toUsRow, type InsiderResult, type SlowData } from "../src/lib/us-scan-core";
import { BENCHMARK, UNIVERSE } from "../src/lib/universe";
import { US_BENCHMARK, US_SECTOR_ETFS, US_UNIVERSE } from "../src/lib/us-universe";
import { bigHolderSeries } from "../src/lib/holders";
import { etfFlow, flowFrom, sectorRotation, type FlowInfo } from "../src/lib/flows";
import { trailingReturn, type Bar } from "../src/lib/score";
import { parseForm4Purchases } from "../src/lib/us-extra";
import {
  addDays, earningsDatesFrom8K, holderAsOf, insiderAsOf, isWednesday, liquidityAsOf, nextOnOrAfter,
  parseMarginDay, type FiledBuy,
} from "../src/lib/backfill";
import {
  LABEL_COLUMNS, TW_COLUMNS, TW_SECTOR_COLUMNS, US_COLUMNS, US_ETF_COLUMNS,
  computeLabels, flattenTw, flattenUs, mergeRows, monthOf, parseCsv, toCsv,
  type PricePoint, type Record_, type TwScanLike, type UsScanLike,
} from "../src/lib/snapshot";

const market = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR ?? "data");
const years = Number(process.env.YEARS ?? 3);
const deadline = Date.now() + Number(process.env.MAX_MINUTES ?? 300) * 60_000;
const range = years <= 4 ? "5y" : "10y";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ymdDash = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const today = new Date().toISOString().slice(0, 10);
const str = (v: unknown) => (v == null ? "" : String(v));
/** 資料來源默默失敗會讓回填看似成功卻缺資料，所以集中記錄，最後讓排程顯示失敗。 */
const problems: string[] = [];

const histDir = path.join(outDir, "history");
const rawDir = path.join(histDir, "raw");

async function loadRows(file: string) {
  try {
    return parseCsv(await readFile(file, "utf8"));
  } catch {
    return [] as Array<Record<string, string>>;
  }
}
async function saveRows(file: string, rows: Record_[], columns: readonly string[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, toCsv(rows, columns));
}

/** 依月份分檔寫入（同鍵覆寫）。 */
async function writeMonthly(folder: string, rows: Record_[], columns: readonly string[], keys: readonly string[]) {
  const byMonth = new Map<string, Record_[]>();
  for (const row of rows) {
    const month = monthOf(String(row.session_date));
    const list = byMonth.get(month) ?? [];
    list.push(row);
    byMonth.set(month, list);
  }
  const keyOf = (r: Record<string, unknown>) => keys.map((k) => String(r[k] ?? "")).join("|");
  for (const [month, list] of byMonth) {
    const file = path.join(histDir, folder, `${month}.csv`);
    const merged = mergeRows(await loadRows(file), list, columns, keyOf);
    await saveRows(file, merged, columns);
  }
  console.log(`history/${folder}: ${rows.length} 列，${byMonth.size} 個月`);
}

async function writeLabels(name: string, rows: Record_[], idColumn: string) {
  const points: PricePoint[] = [];
  for (const r of rows) {
    const close = Number(r.close);
    if (!r.session_date || r[idColumn] == null || !Number.isFinite(close)) continue;
    const bench = r.bench_price == null || r.bench_price === "" ? null : Number(r.bench_price);
    points.push({ date: String(r.session_date), id: String(r[idColumn]), close, bench: Number.isFinite(bench) ? bench : null });
  }
  await saveRows(path.join(histDir, "labels", `${name}.csv`), computeLabels(points), LABEL_COLUMNS);
  console.log(`history/labels/${name}.csv: ${points.length} 列`);
}

/** 失敗或查無資料時，等 20 秒重試，最多 3 次。 */
async function politely<T>(fn: () => Promise<T | null>): Promise<{ status: "ok"; value: T } | { status: "empty" }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = await fn();
      if (value != null) return { status: "ok", value };
    } catch (error) {
      console.log(`  請求失敗：${error instanceof Error ? error.message : error}`);
    }
    await sleep(20_000);
  }
  return { status: "empty" };
}

function toMap<K, V>(rows: Array<Record<string, string>>, keyFn: (r: Record<string, string>) => K, valFn: (r: Record<string, string>) => V) {
  const m = new Map<K, V>();
  for (const r of rows) m.set(keyFn(r), valFn(r));
  return m;
}

// ======================= 台股 =======================

async function backfillTw() {
  const codes = new Set(UNIVERSE.map((s) => s.code));
  console.log(`台股回填：${years} 年，${UNIVERSE.length} 檔`);

  const benchBars = await fetchBars(BENCHMARK.code, ".TW", range);
  const dayOf = (bar: Bar) => new Date(bar.t + 8 * 3_600_000).toISOString().slice(0, 10);
  const startDate = addDays(today, -Math.round(365 * years));
  const allDates = benchBars.map(dayOf);
  const dates = allDates.filter((d) => d >= startDate && d < today);
  console.log(`交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  const barsByCode = new Map<string, Bar[]>();
  await mapPool(UNIVERSE, 4, async (s) => {
    try {
      barsByCode.set(s.code, await fetchBars(s.code, ".TW", range));
    } catch {
      console.log(`  ${s.code} 日線取得失敗`);
    }
  });

  // ---- 三大法人 T86（一天一次請求，含全部個股；只留名單內的）----
  const t86File = path.join(rawDir, "t86.csv");
  const t86DoneFile = path.join(rawDir, "t86_done.csv");
  const t86Rows = await loadRows(t86File);
  const t86Done = new Set((await loadRows(t86DoneFile)).map((r) => r.date!));
  const flushT86 = async () => {
    await saveRows(t86File, t86Rows, ["date", "code", "foreign", "trust", "dealer", "total"]);
    await saveRows(t86DoneFile, [...t86Done].sort().map((date) => ({ date })), ["date"]);
  };
  let bad = 0;
  let fetched = 0;
  for (const d of dates) {
    if (t86Done.has(d)) continue;
    if (Date.now() > deadline) {
      console.log("時間到，T86 先存檔，下次再續跑");
      break;
    }
    const result = await politely(() => fetchT86(d.replace(/-/g, "")));
    if (result.status === "ok") {
      bad = 0;
      for (const [code, c] of result.value.map) {
        if (codes.has(code)) t86Rows.push({ date: d, code, foreign: str(c.foreign), trust: str(c.trust), dealer: str(c.dealer), total: str(c.total) });
      }
      t86Done.add(d);
    } else {
      bad += 1;
      if (bad >= 5) {
        console.log("連續 5 天查不到，可能被證交所限流，T86 停止");
        break;
      }
      t86Done.add(d);
    }
    fetched += 1;
    if (fetched % 40 === 0) {
      await flushT86();
      console.log(`  T86 已處理 ${fetched} 天`);
    }
    await sleep(2200);
  }
  await flushT86();

  // ---- 融資融券（依日期）----
  const marginFile = path.join(rawDir, "margin.csv");
  const marginDoneFile = path.join(rawDir, "margin_done.csv");
  const marginRows = await loadRows(marginFile);
  const marginDone = new Set((await loadRows(marginDoneFile)).map((r) => r.date!));
  const MARGIN_COLS = ["date", "code", "margin_bal", "margin_prev", "margin_limit", "short_bal", "short_prev"] as const;
  const flushMargin = async () => {
    await saveRows(marginFile, marginRows, MARGIN_COLS);
    await saveRows(marginDoneFile, [...marginDone].sort().map((date) => ({ date })), ["date"]);
  };
  bad = 0;
  fetched = 0;
  let loggedSample = false;
  for (const d of dates) {
    if (marginDone.has(d)) continue;
    if (Date.now() > deadline) {
      console.log("時間到，融資融券先存檔，下次再續跑");
      break;
    }
    const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d.replace(/-/g, "")}&selectType=ALL&response=json`;
    const result = await politely(async () => {
      const json = await getJson<Parameters<typeof parseMarginDay>[0] & { stat?: string }>(url);
      if (!loggedSample) {
        loggedSample = true;
        console.log(`  融資融券回應 stat=${json.stat} tables=${json.tables?.length ?? 0}`);
      }
      const parsed = parseMarginDay(json);
      return parsed.size > 0 ? parsed : null;
    });
    if (result.status === "ok") {
      bad = 0;
      for (const [code, m] of result.value) {
        if (codes.has(code)) {
          marginRows.push({ date: d, code, margin_bal: str(m.marginBal), margin_prev: str(m.marginPrev), margin_limit: str(m.marginLimit), short_bal: str(m.shortBal), short_prev: str(m.shortPrev) });
        }
      }
      marginDone.add(d);
    } else {
      bad += 1;
      if (bad >= 5) {
        console.log("連續 5 天解析不到融資融券（欄位格式可能不同或被限流），融資融券停止");
        break;
      }
      marginDone.add(d);
    }
    fetched += 1;
    if (fetched % 40 === 0) {
      await flushMargin();
      console.log(`  融資融券已處理 ${fetched} 天`);
    }
    await sleep(2200);
  }
  await flushMargin();

  // ---- 千張大戶（FinMind，一檔一次請求，回溯到起點前 90 天）----
  const holderSeries = new Map<string, Array<[string, number]>>();
  const token = process.env.FINMIND_TOKEN?.trim();
  await mapPool(UNIVERSE, 3, async (s) => {
    try {
      const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockHoldingSharesPer&data_id=${s.code}&start_date=${addDays(startDate, -90)}${token ? `&token=${token}` : ""}`;
      const json = await getJson<{ status?: number; data?: Array<Record<string, string | number>> }>(url);
      if (json.status === 200 && Array.isArray(json.data)) holderSeries.set(s.code, bigHolderSeries(json.data));
    } catch {
      console.log(`  ${s.code} 集保資料取得失敗`);
    }
  });
  console.log(`集保大戶：${holderSeries.size}/${UNIVERSE.length} 檔`);

  // ---- 組裝每個交易日 ----
  const t86ByDate = new Map<string, Map<string, ChipRow>>();
  for (const r of t86Rows) {
    const m = t86ByDate.get(r.date!) ?? new Map<string, ChipRow>();
    m.set(r.code!, { foreign: Number(r.foreign), trust: Number(r.trust), dealer: Number(r.dealer), total: Number(r.total) });
    t86ByDate.set(r.date!, m);
  }
  const marginByDate = new Map<string, Map<string, MarginRaw>>();
  for (const r of marginRows) {
    const m = marginByDate.get(r.date!) ?? new Map<string, MarginRaw>();
    m.set(r.code!, {
      marginBal: Number(r.margin_bal), marginPrev: Number(r.margin_prev),
      marginLimit: r.margin_limit === "" ? null : Number(r.margin_limit),
      shortBal: Number(r.short_bal), shortPrev: Number(r.short_prev),
    });
    marginByDate.set(r.date!, m);
  }
  if (t86ByDate.size < dates.length * 0.5) problems.push(`三大法人只有 ${t86ByDate.size}/${dates.length} 天（被限流或尚未跑完，可再執行一次續跑）`);
  if (marginByDate.size < dates.length * 0.5) problems.push(`融資融券只有 ${marginByDate.size}/${dates.length} 天（被限流、尚未跑完，或欄位格式不同）`);
  if (holderSeries.size < UNIVERSE.length * 0.8) problems.push(`集保大戶只有 ${holderSeries.size}/${UNIVERSE.length} 檔（FinMind 失敗或額度用完，可設 FINMIND_TOKEN）`);
  const idxByCode = new Map<string, Map<string, number>>();
  for (const [code, bars] of barsByCode) idxByCode.set(code, toMap(bars.map((b, i) => ({ d: dayOf(b), i: String(i) })), (r) => r.d!, (r) => Number(r.i)));
  const benchIdx = toMap(benchBars.map((b, i) => ({ d: dayOf(b), i: String(i) })), (r) => r.d!, (r) => Number(r.i));

  const stockRows: Record_[] = [];
  const sectorRows: Record_[] = [];
  for (let di = 0; di < dates.length; di += 1) {
    const D = dates[di]!;
    const bi = benchIdx.get(D);
    if (bi == null || bi < 21) continue;
    const benchCloses = benchBars.slice(0, bi + 1).map((b) => b.c);
    const benchRet20 = trailingReturn(benchCloses, 20);
    const benchLast = benchBars[bi]!;
    const benchPrev = benchBars[bi - 1]!;
    const chipDay = t86ByDate.get(D);
    const marginDay = marginByDate.get(D);
    const rows: NonNullable<ReturnType<typeof toRow>>[] = [];
    const sectorItems: Array<{ sector: string; days: Array<[string, number]> }> = [];
    let holderDate: string | null = null;

    for (const s of UNIVERSE) {
      const bars = barsByCode.get(s.code);
      const idx = idxByCode.get(s.code)?.get(D);
      if (!bars || idx == null) continue;
      const upto = bars.slice(0, idx + 1);
      if (upto.length >= 20) {
        sectorItems.push({ sector: s.sector, days: upto.slice(-20).map((b): [string, number] => [dayOf(b), b.c * b.v]) });
      }
      const chip = chipDay?.get(s.code);
      let flow: FlowInfo | null = null;
      if (chip && di >= 4) {
        const span = dates.slice(di - 4, di + 1).map((d) => t86ByDate.get(d)?.get(s.code));
        flow = flowFrom(span.map((c) => c?.foreign ?? 0), span.map((c) => c?.trust ?? 0));
      }
      const holders = holderAsOf(holderSeries.get(s.code) ?? [], D) ?? undefined;
      if (holders && (holderDate == null || holders.date > holderDate)) holderDate = holders.date;
      const row = toRow(s, upto, chip, undefined, holders, flow, marginDay?.get(s.code), isWednesday(D), benchRet20);
      if (row) rows.push(row);
    }
    if (rows.length === 0) continue;
    const sectors = sectorRotation(sectorItems);
    const ratio = new Map(sectors.map((x) => [x.sector, x.ratio]));
    for (const r of rows) r.sectorRatio = ratio.get(r.sector) ?? null;

    const scan: TwScanLike = {
      scannedAt: Date.parse(`${D}T14:30:00Z`),
      sessionDate: D,
      chipDate: chipDay ? D : null,
      holderDate,
      settlement: isWednesday(D),
      flowDays: chipDay ? 5 : 0,
      benchmark: { price: Math.round(benchLast.c * 100) / 100, changePct: Math.round(((benchLast.c / benchPrev.c) - 1) * 10000) / 100, ret20: benchRet20 == null ? null : Math.round(benchRet20 * 100) / 100 },
      rows,
      sectors,
    };
    const flat = flattenTw(scan);
    stockRows.push(...flat.stocks);
    sectorRows.push(...flat.sectors);
  }
  await writeMonthly("tw", stockRows, TW_COLUMNS, ["session_date", "code"]);
  await writeMonthly("tw_sectors", sectorRows, TW_SECTOR_COLUMNS, ["session_date", "sector"]);
  await writeLabels("tw", stockRows, "code");
  console.log(`完成：法人 ${t86ByDate.size} 天、融資融券 ${marginByDate.size} 天`);
}

// ======================= 美股 =======================

async function backfillUs() {
  console.log(`美股回填：${years} 年，${US_UNIVERSE.length} 檔`);
  const startDate = addDays(today, -Math.round(365 * years));
  const dayOf = (bar: Bar) => new Date(bar.t - 5 * 3_600_000).toISOString().slice(0, 10); // 美東日期（夏令時差 1 小時，不影響日期）

  const symbols = [US_BENCHMARK.symbol, ...US_SECTOR_ETFS.map((e) => e.symbol), ...US_UNIVERSE.map((s) => s.symbol)];
  const barsBySymbol = new Map<string, Bar[]>();
  await mapPool(symbols, 4, async (symbol) => {
    try {
      barsBySymbol.set(symbol, await fetchBars(symbol, "", range));
    } catch {
      console.log(`  ${symbol} 日線取得失敗`);
    }
  });
  const spy = barsBySymbol.get(US_BENCHMARK.symbol);
  if (!spy) throw new Error("取不到 SPY 日線");
  const dates = spy.map(dayOf).filter((d) => d >= startDate && d < today);
  console.log(`交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  // ---- FRED ----
  const [rrp, walcl, tga] = await Promise.all([fetchFred("RRPONTSYD"), fetchFred("WALCL"), fetchFred("WTREGEN")]);
  console.log(`FRED：RRP ${rrp.length}、WALCL ${walcl.length}、TGA ${tga.length}`);
  if (rrp.length === 0 || walcl.length === 0 || tga.length === 0) problems.push("FRED 流動性資料不完整");

  // ---- SEC：8-K 財報日 + Form 4 買進 ----
  const earningsBySymbol = new Map<string, string[]>();
  const coverageBySymbol = new Map<string, string>();
  const buysBySymbol = new Map<string, FiledBuy[]>();
  const buysFile = path.join(rawDir, "form4_buys.csv");
  const doneFile = path.join(rawDir, "form4_done.csv");
  const BUY_COLS = ["symbol", "filed", "owner", "title", "officer", "director", "txn_date", "shares", "price"] as const;
  const buyRows = await loadRows(buysFile);
  const done = new Set((await loadRows(doneFile)).map((r) => r.accession!));
  const flushSec = async () => {
    await saveRows(buysFile, buyRows, BUY_COLS);
    await saveRows(doneFile, [...done].map((accession) => ({ accession })), ["accession"]);
  };

  const todo: Array<{ symbol: string; cik: string; acc: string; doc: string; filed: string }> = [];
  const allForm4 = new Map<string, string[]>();
  for (const s of US_UNIVERSE) {
    if (s.foreignIssuer) continue;
    try {
      const cik = await cikOf(s.symbol);
      if (!cik) continue;
      const sub = JSON.parse(
        await secFetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`),
      ) as { filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[]; items?: string[] } } };
      const recent = sub.filings?.recent;
      if (!recent?.form) continue;
      const filed = (recent.filingDate ?? []).slice().sort();
      if (filed.length) coverageBySymbol.set(s.symbol, filed[0]!);
      earningsBySymbol.set(s.symbol, earningsDatesFrom8K(recent));
      for (let i = 0; i < recent.form.length; i += 1) {
        if (recent.form[i] !== "4") continue;
        const acc = recent.accessionNumber?.[i];
        const doc = recent.primaryDocument?.[i];
        const date = recent.filingDate?.[i];
        if (acc) allForm4.set(s.symbol, [...(allForm4.get(s.symbol) ?? []), acc]);
        if (acc && doc && date && !done.has(acc)) todo.push({ symbol: s.symbol, cik, acc, doc, filed: date });
      }
      console.log(`  ${s.symbol}：SEC 申報覆蓋自 ${filed[0]}，財報日 ${earningsBySymbol.get(s.symbol)?.length ?? 0} 筆`);
    } catch (error) {
      console.log(`  ${s.symbol} SEC 資料取得失敗：${error instanceof Error ? error.message : error}`);
    }
  }
  const needSec = US_UNIVERSE.filter((s) => !s.foreignIssuer).length;
  if (coverageBySymbol.size < needSec) {
    problems.push(`SEC 申報只取得 ${coverageBySymbol.size}/${needSec} 檔。最常見原因是 SEC 拒絕了 User-Agent（需要含聯絡信箱），請設定 SEC_USER_AGENT`);
  }
  if (earningsBySymbol.size === 0) problems.push("沒有取得任何財報日（8-K）");
  console.log(`待讀 Form 4：${todo.length} 份`);
  let processed = 0;
  let secFailed = 0;
  await mapPool(todo, 3, async (item) => {
    if (Date.now() > deadline) return;
    try {
      const xml = await secFetch(
        `https://www.sec.gov/Archives/edgar/data/${item.cik}/${item.acc.replace(/-/g, "")}/${item.doc.replace(/^xslF345X\d+\//, "")}`,
      );
      for (const b of parseForm4Purchases(xml)) {
        buyRows.push({ symbol: item.symbol, filed: item.filed, owner: b.owner, title: b.title, officer: b.isOfficer ? "1" : "0", director: b.isDirector ? "1" : "0", txn_date: b.date, shares: str(b.shares), price: str(b.price) });
      }
      done.add(item.acc);
    } catch {
      secFailed += 1; // 讀不到就留待下次（不寫入已處理清單）
    }
    processed += 1;
    if (processed % 100 === 0) {
      await flushSec();
      console.log(`  Form 4 已處理 ${processed}/${todo.length}`);
    }
  });
  await flushSec();
  if (todo.length > 0 && processed === 0) problems.push("Form 4 一份都沒讀到");
  // 只要某檔還有 Form 4 沒成功讀到，它的內部人結論就不完整：設為「未知」，不能當作「沒有買進」
  for (const [symbol, accessions] of allForm4) {
    const missing = accessions.filter((a) => !done.has(a)).length;
    if (missing > 0) {
      coverageBySymbol.delete(symbol);
      problems.push(`${symbol} 還有 ${missing}/${accessions.length} 份 Form 4 沒讀到，內部人欄位先標為未知（再執行一次會續做）`);
    }
  }
  if (secFailed > 0) console.log(`Form 4 讀取失敗 ${secFailed} 份`);
  if (processed > 0) console.log(`Form 4 讀取完成：${processed} 份，買進紀錄累計 ${buyRows.length} 筆`);
  for (const r of buyRows) {
    const list = buysBySymbol.get(r.symbol!) ?? [];
    list.push({
      owner: r.owner!, title: r.title!, isOfficer: r.officer === "1", isDirector: r.director === "1",
      date: r.txn_date!, shares: Number(r.shares), price: Number(r.price), filed: r.filed!,
    });
    buysBySymbol.set(r.symbol!, list);
  }

  // ---- 組裝每個交易日 ----
  const idx = new Map<string, Map<string, number>>();
  for (const [sym, bars] of barsBySymbol) idx.set(sym, toMap(bars.map((b, i) => ({ d: dayOf(b), i: String(i) })), (r) => r.d!, (r) => Number(r.i)));
  const stockRows: Record_[] = [];
  const etfRows: Record_[] = [];
  for (const D of dates) {
    const si = idx.get(US_BENCHMARK.symbol)?.get(D);
    if (si == null || si < 21) continue;
    const nowMs = Date.parse(`${D}T21:00:00Z`);
    const spyCloses = spy.slice(0, si + 1).map((b) => b.c);
    const benchRet20 = trailingReturn(spyCloses, 20);
    const sLast = spy[si]!;
    const sPrev = spy[si - 1]!;

    const slow: SlowData = { earnings: new Map<string, number | null>(), insiders: new Map<string, InsiderResult>() };
    for (const s of US_UNIVERSE) {
      const dates8k = earningsBySymbol.get(s.symbol);
      if (dates8k && dates8k.length > 0) {
        const next = nextOnOrAfter(dates8k, D);
        slow.earnings.set(s.symbol, next ? Date.parse(`${next}T21:00:00Z`) : null);
      }
      if (!s.foreignIssuer) {
        const summary = insiderAsOf(buysBySymbol.get(s.symbol) ?? [], coverageBySymbol.get(s.symbol) ?? null, D, nowMs);
        slow.insiders.set(s.symbol, summary ? { status: "ok", summary } : { status: "fail" });
      }
    }

    const rows: NonNullable<ReturnType<typeof toUsRow>>[] = [];
    for (const s of US_UNIVERSE) {
      const bars = barsBySymbol.get(s.symbol);
      const i = idx.get(s.symbol)?.get(D);
      if (!bars || i == null) continue;
      const row = toUsRow(s, bars.slice(0, i + 1), benchRet20, slow, nowMs);
      if (row) rows.push(row);
    }
    if (rows.length === 0) continue;

    const liq = liquidityAsOf(walcl, tga, rrp, D);
    const etfs = US_SECTOR_ETFS.flatMap((e) => {
      const bars = barsBySymbol.get(e.symbol);
      const i = idx.get(e.symbol)?.get(D);
      return bars && i != null && i >= 21 ? [etfFlow(e, bars.slice(0, i + 1), spy.slice(0, si + 1))] : [];
    });
    const scan: UsScanLike = {
      scannedAt: nowMs,
      sessionDate: D,
      benchmark: { price: Math.round(sLast.c * 100) / 100, changePct: Math.round(((sLast.c / sPrev.c) - 1) * 10000) / 100, ret20: benchRet20 == null ? null : Math.round(benchRet20 * 100) / 100 },
      liquidity: liq.rrp,
      netLiquidity: liq.net,
      etfs,
      rows,
    };
    const flat = flattenUs(scan);
    stockRows.push(...flat.stocks);
    etfRows.push(...flat.etfs);
  }
  await writeMonthly("us", stockRows, US_COLUMNS, ["session_date", "symbol"]);
  await writeMonthly("us_etfs", etfRows, US_ETF_COLUMNS, ["session_date", "symbol"]);
  await writeLabels("us", stockRows, "symbol");
}

async function main() {
  if (market === "tw") await backfillTw();
  else if (market === "us") await backfillUs();
  else throw new Error("用法：backfill.ts tw|us");
  if (problems.length > 0) {
    console.error("\n回填有缺漏（已存下抓到的部分）：");
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log("\n回填完成，沒有發現缺漏");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
