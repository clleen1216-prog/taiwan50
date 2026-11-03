/**
 * 美股資金流資料收集（point-in-time），輸出到 OUT_DIR/us_flows/：
 *   finra/YYYY-MM.csv    FINRA 每日空單成交量（可回填 3 年，之後每日增量）
 *   options/YYYY-MM.csv  選擇權 Put/Call 成交量與未平倉（只能每日往前累積，免費來源沒有歷史）
 *   inst13f.csv          SEC 13F 機構持股（季度；可回填）
 *   inst13f_cusip.csv    13F 各標的使用的 CUSIP（供人工核對）
 *
 * 用法：npx tsx --tsconfig tsconfig.json scripts/flows-us.ts finra|options|13f
 * 環境變數：OUT_DIR、YEARS（finra 回填年數，預設 3）、SEC_USER_AGENT（13F）
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fetchChain, secUa } from "../src/lib/us-scan-core";
import { US_UNIVERSE } from "../src/lib/us-universe";
import { mergeRows, monthOf, parseCsv, toCsv, type Record_ } from "../src/lib/snapshot";
import {
  EMPTY_OPTIONS,
  addOptionTotals,
  filedInTime,
  finraSymbol,
  dominantCusips,
  holdingsUsableFrom,
  matchRule,
  normalizeSecDate,
  parseFinraShortVol,
  pickCusips,
  pickExpiries,
  ratio,
  type Filing,
  type NameRule,
  type OptionTotals,
  type QuarterRow,
} from "../src/lib/us-flows";
import { addDays } from "../src/lib/backfill";

const mode = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR ?? "data");
const root = path.join(outDir, "us_flows");
const problems: string[] = [];
const logLines: string[] = [];
const note = (line: string) => {
  console.log(line);
  logLines.push(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRows(file: string) {
  try {
    return parseCsv(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function upsertMonthly(folder: string, date: string, rows: Record_[], columns: readonly string[], keys: readonly string[]) {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${monthOf(date)}.csv`);
  const keyOf = (r: Record<string, unknown>) => keys.map((c) => String(r[c] ?? "")).join("|");
  const merged = mergeRows(await readRows(file), rows, columns, keyOf);
  await writeFile(file, toCsv(merged, columns));
}

// ---------------- FINRA ----------------

const FINRA_COLUMNS = ["session_date", "symbol", "short_vol", "exempt_vol", "total_vol", "short_ratio"] as const;

async function finra() {
  const years = Number(process.env.YEARS ?? "3");
  const today = new Date().toISOString().slice(0, 10);
  const start = addDays(today, -Math.round(years * 365));
  const dir = path.join(root, "finra");
  await mkdir(dir, { recursive: true });
  const have = new Set<string>();
  for (const f of (await readdir(dir)).filter((n) => /^\d{4}-\d{2}\.csv$/.test(n))) {
    for (const r of await readRows(path.join(dir, f))) have.add(r.session_date!);
  }
  const holidayFile = path.join(dir, "no_file_days.txt");
  const holidays = new Set<string>((await readFile(holidayFile, "utf8").catch(() => "")).split("\n").filter(Boolean));
  const wanted = new Map(US_UNIVERSE.map((s) => [finraSymbol(s.symbol).toUpperCase(), s.symbol]));
  const wantedSet = new Set(wanted.keys());

  const days: string[] = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || have.has(d) || holidays.has(d)) continue;
    days.push(d);
  }
  console.log(`FINRA：待抓 ${days.length} 天（已有 ${have.size} 天）`);

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < days.length) {
      const d = days[next++]!;
      const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${d.replace(/-/g, "")}.txt`;
      let text: string | null = null;
      let missing = false;
      for (let attempt = 0; attempt < 3 && text == null && !missing; attempt += 1) {
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Flagship50/1.0)" } });
          if (res.status === 404 || res.status === 403) missing = true;
          else if (res.ok) text = await res.text();
          else await sleep(2000 * (attempt + 1));
        } catch {
          await sleep(2000 * (attempt + 1));
        }
      }
      if (missing) {
        if (d < addDays(today, -1)) holidays.add(d); // 太新的日子可能只是還沒發布，不記為休市
        continue;
      }
      if (text == null) {
        problems.push(`FINRA ${d} 下載失敗`);
        continue;
      }
      try {
        const parsed = parseFinraShortVol(text, wantedSet);
        if (parsed.length < US_UNIVERSE.length * 0.8) {
          problems.push(`FINRA ${d} 只找到 ${parsed.length}/${US_UNIVERSE.length} 檔`);
          continue;
        }
        const rows: Record_[] = parsed.map((r) => ({
          session_date: d,
          symbol: wanted.get(r.symbol) ?? r.symbol,
          short_vol: r.shortVol,
          exempt_vol: r.exemptVol,
          total_vol: r.totalVol,
          short_ratio: Math.round((r.shortVol / r.totalVol) * 1000) / 1000,
        }));
        await upsertMonthly("finra", d, rows, FINRA_COLUMNS, ["session_date", "symbol"]);
        done += 1;
        if (done % 50 === 0) console.log(`FINRA：已寫入 ${done}/${days.length}`);
      } catch (error) {
        problems.push(`FINRA ${d} 解析失敗：${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await writeFile(holidayFile, [...holidays].sort().join("\n") + "\n");
  console.log(`FINRA 完成：新增 ${done} 天`);
}

// ---------------- 選擇權 ----------------

const OPTION_COLUMNS = ["session_date", "symbol", "call_vol", "put_vol", "call_oi", "put_oi", "pc_vol", "pc_oi", "expiries"] as const;

function etDate(ms: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

async function options() {
  const now = Date.now();
  const sessionDate = etDate(now);
  const rows: Record_[] = [];
  let stale = 0;
  for (const stock of US_UNIVERSE) {
    try {
      const first = await fetchChain(stock.symbol);
      const quoteMs = (first?.quote?.regularMarketTime ?? 0) * 1000;
      if (!quoteMs || etDate(quoteMs) !== sessionDate) {
        stale += 1; // 休市或資料還沒更新，這天不寫，避免把舊成交量當今天
        continue;
      }
      const expiries = pickExpiries(first?.expirationDates ?? [], now);
      let total: OptionTotals = EMPTY_OPTIONS;
      for (const [i, e] of expiries.entries()) {
        const chain = i === 0 && first?.expirationDates?.[0] === e ? first : await fetchChain(stock.symbol, e);
        const opt = chain?.options?.[0];
        if (opt) total = addOptionTotals(total, opt.calls ?? [], opt.puts ?? []);
        await sleep(120);
      }
      if (total.expiries === 0 || total.callVol + total.putVol === 0) {
        problems.push(`${stock.symbol} 選擇權資料是空的`);
        continue;
      }
      rows.push({
        session_date: sessionDate,
        symbol: stock.symbol,
        call_vol: total.callVol,
        put_vol: total.putVol,
        call_oi: total.callOi,
        put_oi: total.putOi,
        pc_vol: ratio(total.putVol, total.callVol),
        pc_oi: ratio(total.putOi, total.callOi),
        expiries: total.expiries,
      });
    } catch (error) {
      problems.push(`${stock.symbol} 選擇權抓取失敗：${error instanceof Error ? error.message : error}`);
    }
    await sleep(120);
  }
  if (stale === US_UNIVERSE.length) {
    console.log(`選擇權：${sessionDate} 所有報價時間都不是當天（休市），不寫入`);
    return;
  }
  if (rows.length < US_UNIVERSE.length * 0.8) {
    problems.push(`選擇權只取得 ${rows.length}/${US_UNIVERSE.length} 檔，不寫入`);
    return;
  }
  await upsertMonthly("options", sessionDate, rows, OPTION_COLUMNS, ["session_date", "symbol"]);
  console.log(`選擇權：${sessionDate} 寫入 ${rows.length} 檔`);
}

// ---------------- 13F ----------------

const NAME_RULES: NameRule[] = [
  ["NVDA", /^NVIDIA/], ["MU", /^MICRON TECH/], ["AMD", /^ADVANCED MICRO DEVICES/], ["ASML", /^ASML HOLDING/],
  ["TSM", /^TAIWAN SEMICONDUCTOR/], ["INTC", /^INTEL CORP/], ["AAPL", /^APPLE INC/],
  ["GOOGL", /^ALPHABET INC/, /CL A|CLASS A/], ["MSFT", /^MICROSOFT/], ["AMZN", /^AMAZON COM/], ["ORCL", /^ORACLE CORP/],
  ["AVGO", /^BROADCOM/], ["QCOM", /^QUALCOMM/], ["TXN", /^TEXAS INSTR/], ["AMAT", /^APPLIED MATLS|^APPLIED MATERIALS/],
  ["LRCX", /^LAM RESEARCH/], ["KLAC", /^KLA CORP/], ["ADI", /^ANALOG DEVICES/], ["META", /^META PLATFORMS/],
  ["TSLA", /^TESLA/], ["NFLX", /^NETFLIX/], ["CRM", /^SALESFORCE/], ["ADBE", /^ADOBE/], ["NOW", /^SERVICENOW/],
  ["INTU", /^INTUIT(?!IVE)/], ["CSCO", /^CISCO/], ["IBM", /^INTERNATIONAL BUSINESS MACH/], ["DELL", /^DELL TECH/],
  ["JPM", /^JPMORGAN/], ["BAC", /^BANK AMER/], ["GS", /^GOLDMAN SACHS GROUP/], ["V", /^VISA INC/],
  ["MA", /^MASTERCARD/], ["PYPL", /^PAYPAL/], ["BRK-B", /^BERKSHIRE HATHAWAY/, /CL B|CLASS B/],
  ["UNH", /^UNITEDHEALTH/], ["JNJ", /^JOHNSON & JOHNSON|^JOHNSON AND JOHNSON/], ["LLY", /^LILLY/], ["PFE", /^PFIZER/],
  ["MRK", /^MERCK & CO|^MERCK AND CO/], ["ABBV", /^ABBVIE/], ["TMO", /^THERMO FISHER/], ["WMT", /^WALMART/],
  ["COST", /^COSTCO/], ["HD", /^HOME DEPOT/], ["NKE", /^NIKE/], ["MCD", /^MCDONALD/], ["KO", /^COCA[ -]COLA CO/],
  ["PG", /^PROCTER/], ["DIS", /^(WALT )?DISNEY/], ["XOM", /^EXXON/], ["CVX", /^CHEVRON/], ["COP", /^CONOCOPHILLIPS/],
  ["CAT", /^CATERPILLAR/], ["BA", /^BOEING/], ["GE", /^GENERAL ELECTRIC|^GE AEROSPACE/], ["HON", /^HONEYWELL/],
  ["UPS", /^UNITED PARCEL/], ["T", /^AT&T|^AT & T/], ["VZ", /^VERIZON/],
].map(([symbol, name, title]) => ({ symbol, name, title }) as NameRule);

/** SEC 13F 資料集的壓縮檔：2023 以前是季檔，2024 起是滾動三個月。路徑有兩種，逐一嘗試。 */
function zipCandidates(): string[] {
  const dirs = [
    "https://www.sec.gov/files/structureddata/data/form-13f-data-sets",
    "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets",
  ];
  const names = [
    "2023q4_form13f.zip",
    "01jan2024-29feb2024_form13f.zip", "01mar2024-31may2024_form13f.zip", "01jun2024-31aug2024_form13f.zip",
    "01sep2024-30nov2024_form13f.zip", "01dec2024-28feb2025_form13f.zip", "01mar2025-31may2025_form13f.zip",
    "01jun2025-31aug2025_form13f.zip", "01jun2025-30aug2025_form13f.zip", "01jun2025-31jul2025_form13f.zip", "01jul2025-31aug2025_form13f.zip", "01sep2025-30nov2025_form13f.zip", "01dec2025-28feb2026_form13f.zip",
    "01mar2026-31may2026_form13f.zip", "01jun2026-31aug2026_form13f.zip", "01sep2026-30nov2026_form13f.zip",
  ];
  return names.flatMap((n) => dirs.map((d) => `${d}/${n}`));
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 結束碼 ${code}`))));
  });
}

async function* tsvRows(zip: string, member: string): AsyncGenerator<Record<string, string>> {
  const p = spawn("unzip", ["-p", zip, member], { stdio: ["ignore", "pipe", "inherit"] });
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  let head: string[] | null = null;
  for await (const line of rl) {
    if (!line) continue;
    const f = line.split("\t");
    if (!head) {
      head = f.map((h) => h.trim().toUpperCase());
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < head.length; i += 1) row[head[i]!] = f[i] ?? "";
    yield row;
  }
}

async function discoverZipUrls(): Promise<string[]> {
  const pages = [
    "https://www.sec.gov/dera/data/form-13f",
    "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets",
  ];
  const found = new Set<string>();
  for (const page of pages) {
    try {
      const res = await fetch(page, { headers: { "User-Agent": secUa() }, redirect: "follow" });
      if (!res.ok) continue;
      const html = await res.text();
      for (const m of html.matchAll(/href="([^"]*_form13f\.zip)"/gi)) {
        found.add(new URL(m[1]!, "https://www.sec.gov").toString());
      }
    } catch {
      /* 找不到頁面就用內建清單 */
    }
  }
  note(`13F：從 SEC 頁面找到 ${found.size} 個壓縮檔連結：${[...found].map((u) => u.split("/").pop()).join(", ")}`);
  return [...found];
}

async function download(url: string, file: string): Promise<boolean> {
  const res = await fetch(url, { headers: { "User-Agent": secUa() } });
  if (res.status === 404) return false;
  if (!res.ok || !res.body) throw new Error(`${url} → ${res.status}`);
  const { Readable } = await import("node:stream");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  return true;
}

async function inst13f() {
  const tmp = path.join(root, "_tmp13f");
  await mkdir(tmp, { recursive: true });
  // 2023-06 以前的季度股數與市值對不上（單位疑似不一致），從 2023-09 起算
  const minQuarter = "2023-09-01";

  // 先全部掃一遍，收集「名稱符合的 CUSIP 市值」；第二遍再用選定的 CUSIP 彙總
  const zips: string[] = [];
  const notFound = new Set<string>();
  const seenName = new Set<string>();
  for (const url of [...(await discoverZipUrls()), ...zipCandidates()]) {
    const name = url.split("/").pop()!;
    if (seenName.has(name)) continue;
    const file = path.join(tmp, name);
    try {
      if (await download(url, file)) {
        seenName.add(name);
        zips.push(file);
        note(`13F：下載 ${name}`);
      } else if (!zips.some((z) => path.basename(z) === name)) {
        notFound.add(name);
      }
    } catch (error) {
      problems.push(`13F 下載失敗 ${name}：${error instanceof Error ? error.message : error}`);
      seenName.add(name);
    }
  }
  for (const name of notFound) if (!seenName.has(name)) note(`13F：兩個路徑都找不到 ${name}`);
  if (zips.length === 0) {
    problems.push("13F：一個壓縮檔都沒下載到（網址可能變了）");
    return;
  }

  const filings = new Map<string, Filing>();
  const seenAccession = new Set<string>();
  const cusipValue = new Map<string, number>();
  const holdingsRaw: Array<{ filing: Filing; symbol: string; cusip: string; shares: number; value: number }> = [];

  for (const zip of zips) {
    const subs = new Map<string, { filedOn: string; type: string }>();
    for await (const r of tsvRows(zip, "SUBMISSION.tsv")) {
      const filedOn = normalizeSecDate(r.FILING_DATE ?? "");
      if (filedOn) subs.set(r.ACCESSION_NUMBER!, { filedOn, type: (r.SUBMISSIONTYPE ?? "").trim() });
    }
    const local = new Map<string, Filing>();
    for await (const r of tsvRows(zip, "COVERPAGE.tsv")) {
      const sub = subs.get(r.ACCESSION_NUMBER!);
      const q = normalizeSecDate(r.REPORTCALENDARORQUARTER ?? "");
      if (!sub || !q || q < minQuarter) continue;
      const filing: Filing = { accession: r.ACCESSION_NUMBER!, filedOn: sub.filedOn, type: sub.type, quarterEnd: q };
      if (filedInTime(filing) && !seenAccession.has(filing.accession)) {
        local.set(filing.accession, filing);
        seenAccession.add(filing.accession);
      }
    }
    let matched = 0;
    for await (const r of tsvRows(zip, "INFOTABLE.tsv")) {
      const filing = local.get(r.ACCESSION_NUMBER!);
      if (!filing) continue;
      if ((r.PUTCALL ?? "").trim() || (r.SSHPRNAMTTYPE ?? "").trim().toUpperCase() !== "SH") continue;
      const symbol = matchRule(NAME_RULES, r.NAMEOFISSUER ?? "", r.TITLEOFCLASS ?? "");
      if (!symbol) continue;
      const cusip = (r.CUSIP ?? "").trim().toUpperCase();
      const shares = Number(r.SSHPRNAMT);
      let value = Number(r.VALUE);
      if (!cusip || !Number.isFinite(shares) || !Number.isFinite(value)) continue;
      // 2023-01-03 之前申報的 VALUE 單位是千美元
      if (filing.filedOn < "2023-01-03") value *= 1000;
      matched += 1;
      filings.set(filing.accession, filing);
      const key = `${symbol}|${cusip}`;
      cusipValue.set(key, (cusipValue.get(key) ?? 0) + value);
      holdingsRaw.push({ filing, symbol, cusip, shares, value });
    }
    note(`13F：${path.basename(zip)} 申報 ${local.size} 份，符合名稱的持股 ${matched} 筆`);
  }

  const { chosen, alternates } = pickCusips(cusipValue);
  const missing = US_UNIVERSE.filter((s) => !chosen.has(s.symbol)).map((s) => s.symbol);
  if (missing.length > 5) problems.push(`13F：${missing.length} 檔找不到對應 CUSIP：${missing.join(",")}`);
  await writeFile(
    path.join(root, "inst13f_cusip.csv"),
    toCsv([...chosen].map(([symbol, cusip]) => ({ symbol, cusip, others: (alternates.get(symbol) ?? []).join(" ") })), ["symbol", "cusip", "others"]),
  );

  const agg = new Map<string, { shares: number; valueUsd: number; holders: Set<string> }>();
  for (const h of holdingsRaw) {
    const key = `${h.filing.quarterEnd}|${h.symbol}|${h.cusip}`;
    const a = agg.get(key) ?? { shares: 0, valueUsd: 0, holders: new Set<string>() };
    a.shares += h.shares;
    a.valueUsd += h.value;
    a.holders.add(h.filing.accession);
    agg.set(key, a);
  }
  const quarters: QuarterRow[] = [...dominantCusips(agg)].map(([key, a]) => {
    const [quarter_end, symbol] = key.split("|") as [string, string];
    return { quarter_end, usable_from: holdingsUsableFrom(quarter_end), symbol, cusip: a.cusip, shares: a.shares, value_usd: Math.round(a.valueUsd), holders: a.holders.size, filings: a.holders.size };
  }).sort((a, b) => a.quarter_end.localeCompare(b.quarter_end) || a.symbol.localeCompare(b.symbol));

  // 申報期限還沒過的季度資料不完整，不輸出
  const today = new Date().toISOString().slice(0, 10);
  const complete = quarters.filter((q) => holdingsUsableFrom(q.quarter_end) <= today);
  await writeFile(
    path.join(root, "inst13f.csv"),
    toCsv(complete as unknown as Record_[], ["quarter_end", "usable_from", "symbol", "cusip", "shares", "value_usd", "holders", "filings"]),
  );
  note(`13F：輸出 ${complete.length} 列，涵蓋 ${new Set(complete.map((q) => q.quarter_end)).size} 季、${new Set(complete.map((q) => q.symbol)).size} 檔`);
  await writeFile(path.join(root, "inst13f_log.txt"), logLines.join("\n") + "\n" + (problems.length ? "問題：\n" + problems.join("\n") + "\n" : ""));
  await run("rm", ["-rf", tmp]);
}

// ---------------- 進入點 ----------------

async function main() {
  if (mode === "finra") await finra();
  else if (mode === "options") await options();
  else if (mode === "13f") await inst13f();
  else throw new Error("用法：flows-us.ts finra|options|13f");
  if (problems.length) {
    console.error(`\n有問題（已存下抓到的部分）：\n - ${problems.slice(0, 30).join("\n - ")}${problems.length > 30 ? `\n ...另有 ${problems.length - 30} 項` : ""}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
