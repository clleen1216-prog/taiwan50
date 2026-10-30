/**
 * 每日快照：跑一次完整掃描，把「當下」的所有特徵存成 CSV（point-in-time），
 * 之後才能驗證訊號、訓練模型。很多特徵（法人連續天數、融資、選擇權預期波動）日後無法重建，
 * 所以每天存一次。
 *
 * 用法：npx tsx --tsconfig tsconfig.json scripts/snapshot.ts tw|us
 * 環境變數：OUT_DIR（預設 ./data）、SCAN_WAIT_MS（慢速資料等待上限，毫秒）
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadScan as loadTw } from "../src/lib/scan-core";
import { loadScan as loadUs } from "../src/lib/us-scan-core";
import { UNIVERSE } from "../src/lib/universe";
import { US_UNIVERSE } from "../src/lib/us-universe";
import {
  LABEL_COLUMNS,
  TW_COLUMNS,
  TW_SECTOR_COLUMNS,
  US_COLUMNS,
  US_ETF_COLUMNS,
  computeLabels,
  flattenTw,
  flattenUs,
  mergeRows,
  monthOf,
  parseCsv,
  toCsv,
  type PricePoint,
  type Record_,
} from "../src/lib/snapshot";

const market = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR ?? "data");

async function readRows(file: string) {
  try {
    return parseCsv(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function upsert(
  folder: string,
  sessionDate: string,
  incoming: Record_[],
  columns: readonly string[],
  keyColumns: readonly string[],
) {
  const dir = path.join(outDir, folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${monthOf(sessionDate)}.csv`);
  const keyOf = (row: Record<string, unknown>) => keyColumns.map((c) => String(row[c] ?? "")).join("|");
  const merged = mergeRows(await readRows(file), incoming, columns, keyOf);
  await writeFile(file, toCsv(merged, columns));
  console.log(`${folder}/${path.basename(file)}: ${incoming.length} 列寫入，檔內共 ${merged.length} 列`);
}

async function rebuildLabels(folder: string, idColumn: string) {
  const dir = path.join(outDir, folder);
  const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}\.csv$/.test(f)).sort();
  const points: PricePoint[] = [];
  for (const f of files) {
    for (const row of await readRows(path.join(dir, f))) {
      const close = Number(row.close);
      if (!row.session_date || !row[idColumn] || !Number.isFinite(close)) continue;
      const bench = row.bench_price === "" || row.bench_price == null ? null : Number(row.bench_price);
      points.push({ date: row.session_date, id: row[idColumn]!, close, bench: Number.isFinite(bench) ? bench : null });
    }
  }
  const labels = computeLabels(points);
  await mkdir(path.join(outDir, "labels"), { recursive: true });
  await writeFile(path.join(outDir, "labels", `${folder}.csv`), toCsv(labels, LABEL_COLUMNS));
  console.log(`labels/${folder}.csv: ${labels.length} 列`);
}

async function main() {
  if (market === "tw") {
    const scan = await loadTw(true);
    if (!scan.ok) throw new Error(`台股掃描失敗：${scan.error}`);
    if (scan.rows.length < UNIVERSE.length * 0.8) {
      throw new Error(`台股只掃到 ${scan.rows.length}/${UNIVERSE.length} 檔，資料不完整，不存檔`);
    }
    const { stocks, sectors } = flattenTw(scan);
    await upsert("tw", scan.sessionDate, stocks, TW_COLUMNS, ["session_date", "code"]);
    await upsert("tw_sectors", scan.sessionDate, sectors, TW_SECTOR_COLUMNS, ["session_date", "sector"]);
    await rebuildLabels("tw", "code");
    console.log(`台股行情日 ${scan.sessionDate}；籌碼日 ${scan.chipDate}；集保週 ${scan.holderDate}；法人天數 ${scan.flowDays}`);
  } else if (market === "us") {
    const scan = await loadUs(true);
    if (!scan.ok) throw new Error(`美股掃描失敗：${scan.error}`);
    if (scan.rows.length < US_UNIVERSE.length * 0.8) {
      throw new Error(`美股只掃到 ${scan.rows.length}/${US_UNIVERSE.length} 檔，資料不完整，不存檔`);
    }
    const { stocks, etfs } = flattenUs(scan);
    await upsert("us", scan.sessionDate, stocks, US_COLUMNS, ["session_date", "symbol"]);
    await upsert("us_etfs", scan.sessionDate, etfs, US_ETF_COLUMNS, ["session_date", "symbol"]);
    await rebuildLabels("us", "symbol");
    console.log(`美股行情日 ${scan.sessionDate}；財報日 ${scan.earningsKnown} 檔；內部人 ${scan.insiderKnown} 檔`);
  } else {
    throw new Error("用法：snapshot.ts tw|us");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
