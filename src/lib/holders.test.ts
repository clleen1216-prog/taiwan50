import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bigHolderSeries, toHolderInfo } from "./holders.ts";
import { scoreStock, type HolderInfo, type ScoreInput } from "./score.ts";

// FinMind 每週每個級距一列；千張以上 = 級距下限 >= 1,000,001 股
function week(date: string, bigPct: number) {
  return [
    { date, HoldingSharesLevel: "1-999", percent: 0.5 },
    { date, HoldingSharesLevel: "800,001-1,000,000", percent: 3 },
    { date, HoldingSharesLevel: "more than 1,000,001", percent: bigPct },
    { date, HoldingSharesLevel: "total", percent: 100 },
  ];
}

describe("bigHolderSeries / toHolderInfo", () => {
  it("只加總千張以上級距，並依日期排序", () => {
    const rows = [...week("2026-10-17", 70.5), ...week("2026-10-03", 69.8), ...week("2026-10-10", 70.1)];
    assert.deepEqual(bigHolderSeries(rows), [
      ["2026-10-03", 69.8],
      ["2026-10-10", 70.1],
      ["2026-10-17", 70.5],
    ]);
  });

  it("連續增加算出 streak", () => {
    const info = toHolderInfo([
      ["2026-10-03", 69.8],
      ["2026-10-10", 70.1],
      ["2026-10-17", 70.5],
    ]);
    assert.deepEqual(info, { pct: 70.5, change: 0.4, streak: 2, date: "2026-10-17" });
  });

  it("連續減少是負的 streak，反轉後重算", () => {
    assert.equal(toHolderInfo([["a", 70], ["b", 69.5], ["c", 69]])?.streak, -2);
    assert.equal(toHolderInfo([["a", 70], ["b", 69.5], ["c", 69.8]])?.streak, 1);
  });

  it("資料不足兩週回 null；持平中斷連續", () => {
    assert.equal(toHolderInfo([["a", 70]]), null);
    assert.equal(toHolderInfo([["a", 69], ["b", 70], ["c", 70.001]])?.streak, 0);
  });

  it("中文級距也能辨識", () => {
    const rows = [
      { date: "d1", HoldingSharesLevel: "1,000,001以上", percent: "55.5" },
      { date: "d1", HoldingSharesLevel: "合計", percent: "100" },
    ];
    assert.deepEqual(bigHolderSeries(rows), [["d1", 55.5]]);
  });
});

const base: ScoreInput = {
  close: 100, open: 99, high: 101, low: 98, volume: 1000,
  ma5: 100, ma10: 100.5, ma20: 99.5, ma60: 99, volMa20: 1000,
  foreign: 0, trust: 0, settlement: false, ret20: 0, benchRet20: 0, holders: null,
};
const up: HolderInfo = { pct: 70, change: 0.4, streak: 2, date: "2026-10-17" };

describe("scoreStock 千張大戶加分", () => {
  it("入閘 + 連續增持：SOP 與旗艦各 +15", () => {
    const off = scoreStock(base);
    const on = scoreStock({ ...base, holders: up });
    assert.equal(on.holderSide, "concentrating");
    assert.equal(on.sopScore! - off.sopScore!, 15);
    assert.equal(on.flagshipScore - off.flagshipScore, 15);
    assert.ok(on.checks.find((c) => c.label === "千張大戶集中")?.pass);
  });

  it("未入閘不加分", () => {
    const wide = { ...base, ma60: 80, ma20: 90 };
    const off = scoreStock(wide);
    const on = scoreStock({ ...wide, holders: up });
    assert.equal(off.inGate, false);
    assert.equal(on.flagshipScore, off.flagshipScore);
    assert.equal(on.sopScore, null);
  });

  it("沒資料或只增一週都不動分數", () => {
    const off = scoreStock(base);
    assert.equal(scoreStock({ ...base, holders: { ...up, streak: 1 } }).flagshipScore, off.flagshipScore);
    assert.equal(scoreStock(base).holderSide, "unknown");
  });
});
