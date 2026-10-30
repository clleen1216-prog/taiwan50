import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLabels, mergeRows, parseCsv, toCsv, TW_SECTOR_COLUMNS } from "./snapshot.ts";

describe("CSV 讀寫", () => {
  it("逗號、引號、換行可往返；布林存成 1/0；null 為空", () => {
    const rows = [{ a: "x,y", b: 'He said "hi"', c: true, d: null, e: 1.5, f: "line1\nline2" }];
    const text = toCsv(rows, ["a", "b", "c", "d", "e", "f"]);
    const back = parseCsv(text);
    assert.deepEqual(back, [{ a: "x,y", b: 'He said "hi"', c: "1", d: "", e: "1.5", f: "line1\nline2" }]);
  });
  it("CRLF 與結尾沒換行也能讀", () => {
    assert.deepEqual(parseCsv("a,b\r\n1,2\r\n3,4"), [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });
});

describe("mergeRows", () => {
  const cols = ["session_date", "code", "close"] as const;
  const key = (r: Record<string, unknown>) => `${r.session_date}|${r.code}`;
  it("同一天同一檔以新資料覆寫，其餘保留並排序", () => {
    const existing = [
      { session_date: "2026-10-29", code: "2330", close: "1000" },
      { session_date: "2026-10-30", code: "2330", close: "1010" },
    ];
    const merged = mergeRows(existing, [{ session_date: "2026-10-30", code: "2330", close: 1020 }, { session_date: "2026-10-30", code: "2317", close: 200 }], cols, key);
    assert.deepEqual(merged.map((r) => `${r.session_date}|${r.code}|${r.close}`), [
      "2026-10-29|2330|1000",
      "2026-10-30|2317|200",
      "2026-10-30|2330|1020",
    ]);
  });
  it("欄位順序固定，新資料缺的欄位是空值", () => {
    const merged = mergeRows([], [{ session_date: "d", code: "x" }], cols, key);
    assert.deepEqual(Object.keys(merged[0]!), ["session_date", "code", "close"]);
    assert.equal(merged[0]!.close, undefined);
    assert.ok(TW_SECTOR_COLUMNS.length > 0);
  });
});

describe("computeLabels", () => {
  const mk = (n: number, start = "2026-10-01") =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.parse(start) + i * 86_400_000);
      return { date: d.toISOString().slice(0, 10), id: "A", close: 100 + i, bench: 1000 + i * 2 };
    });
  it("往後第 1/5/10 筆快照的報酬與超額報酬", () => {
    const rows = computeLabels(mk(12));
    const first = rows[0]!;
    assert.equal(first.fwd1, 1);
    assert.equal(first.fwd5, 5);
    assert.equal(first.fwd10, 10);
    assert.equal(first.bench_fwd5, 1);
    assert.equal(first.excess5, 4);
    assert.equal(rows[11]!.fwd1, null); // 最後一筆沒有未來
    assert.equal(rows[8]!.fwd10, null);
  });
  it("快照缺漏太久不當作連續交易日", () => {
    const pts = [
      { date: "2026-10-01", id: "A", close: 100, bench: 1 },
      { date: "2026-10-30", id: "A", close: 150, bench: 1 },
    ];
    assert.equal(computeLabels(pts)[0]!.fwd1, null);
  });
});

import { TW_COLUMNS, US_COLUMNS, US_ETF_COLUMNS, flattenTw, flattenUs, type TwScanLike, type UsScanLike } from "./snapshot.ts";

describe("flatten 欄位與欄位表一致", () => {
  const twRow = {
    code: "2330", name: "台積電", sector: "半導體", price: 1000, changePct: 1, open: 1, high: 1, low: 1, volume: 1,
    ma5: 1, ma10: 1, ma20: 1, ma60: 1, spreadPct: 1, volRatio: 1, upperShadow: 0, bearish: false, inGate: true,
    tight: false, bullStack: true, sopScore: 80, sopKind: "coil", flagshipScore: 70, chip: "dual-buy",
    foreign: 1, trust: 1, dealer: 1, totalInst: 3, ret20: 1, ret60: 2, rs20: 0.5, pe: 20, pb: 5, dividendYield: 1.5,
    holderSide: "neutral", bigPct: 70, bigChange: 0.1, bigStreak: 1, sectorRatio: 1.1,
    flow: { foreignStreak: 2, trustStreak: 1, foreign5d: 5, trust5d: 6, days: 5 },
    margin: { marginBal: 1, marginChange: 1, marginChangePct: 1, marginUse: 1, shortBal: 1, shortRatio: 1, side: "neutral" },
  };
  it("台股", () => {
    const scan: TwScanLike = {
      scannedAt: 0, sessionDate: "2026-10-30", chipDate: "2026-10-30", holderDate: "2026-10-24", settlement: false, flowDays: 5,
      benchmark: { price: 100, changePct: 1, ret20: 2 }, rows: [twRow],
      sectors: [{ sector: "半導體", stocks: 5, share5: 1, share20: 1, ratio: 1, trend: "flat" }],
    };
    const { stocks, sectors } = flattenTw(scan);
    for (const c of TW_COLUMNS) assert.ok(c in stocks[0]!, `缺欄位 ${c}`);
    assert.equal(sectors[0]!.session_date, "2026-10-30");
  });
  it("美股", () => {
    const usRow = {
      symbol: "NVDA", name: "輝達", sector: "半導體", price: 1, changePct: 1, open: 1, high: 1, low: 1, volume: 1,
      ma5: 1, ma10: 1, ma20: 1, ma60: 1, spreadPct: 1, volRatio: 1, upperShadow: 0, bearish: false, inGate: true,
      tight: false, bullStack: true, sopScore: 80, sopKind: "coil", flagshipScore: 70, ret20: 1, rs20: 1,
      earningsDays: 3, earningsNear: true, impliedMovePct: 7, impliedIv: 80, insiderApplicable: true, insiderKnown: true,
      insiderBought: false, insiderUsd: 0, insiderBonus: false,
    };
    const scan: UsScanLike = {
      scannedAt: 0, sessionDate: "2026-10-29", benchmark: { price: 600, changePct: 0.5, ret20: 3 },
      liquidity: { value: 10, changeAbs: 1 }, netLiquidity: { value: 5800, changeAbs: -20, status: "neutral" },
      etfs: [{ symbol: "SMH", name: "半導體", rel5: 1, rel20: 2, volRatio: 1.1 }], rows: [usRow],
    };
    const { stocks, etfs } = flattenUs(scan);
    for (const c of US_COLUMNS) assert.ok(c in stocks[0]!, `缺欄位 ${c}`);
    for (const c of US_ETF_COLUMNS) assert.ok(c in etfs[0]!, `缺欄位 ${c}`);
  });
});
