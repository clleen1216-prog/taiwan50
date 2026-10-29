import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStreak, etfFlow, flowFrom, marginFrom, sectorRotation } from "./flows.ts";

describe("法人連續買賣超", () => {
  it("結尾連續同方向，0 與反向會中斷", () => {
    assert.equal(computeStreak([-5, 3, 4, 9]), 3);
    assert.equal(computeStreak([5, 3, -4, -9]), -2);
    assert.equal(computeStreak([5, 3, 0, 9]), 1);
    assert.equal(computeStreak([5, 3, 4, 0]), 0);
    assert.equal(computeStreak([]), 0);
  });
  it("合計與天數", () => {
    const f = flowFrom([1000, 2000, -500], [0, 100, 200]);
    assert.deepEqual(f, { foreignStreak: -1, trustStreak: 2, foreign5d: 2500, trust5d: 300, days: 3 });
  });
});

describe("融資融券", () => {
  const raw = { marginBal: 10300, marginPrev: 10000, marginLimit: 50000, shortBal: 500, shortPrev: 480 };
  it("融資增加且收紅 → heating；使用率與券資比", () => {
    const m = marginFrom(raw, 1.2);
    assert.equal(m.side, "heating");
    assert.equal(m.marginChange, 300);
    assert.equal(m.marginChangePct, 3);
    assert.equal(m.marginUse, 20.6);
    assert.equal(m.shortRatio, 4.9);
  });
  it("融資減少且沒收黑 → cooling；收黑時融資增加不算 heating；前值 0 不除以零", () => {
    assert.equal(marginFrom({ ...raw, marginBal: 9700 }, 0).side, "cooling");
    assert.equal(marginFrom(raw, -1).side, "neutral");
    assert.equal(marginFrom({ ...raw, marginPrev: 0, marginLimit: null }, 1).marginChangePct, 0);
  });
});

describe("類股資金輪動", () => {
  const days = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}`);
  it("近 5 日占比放大 → in", () => {
    const a = days.map((d, i): [string, number] => [d, i >= 15 ? 300 : 100]);
    const b = days.map((d): [string, number] => [d, 100]);
    const out = sectorRotation([{ sector: "A", days: a }, { sector: "B", days: b }]);
    assert.equal(out[0]!.sector, "A");
    assert.equal(out[0]!.trend, "in");
    assert.equal(out[1]!.trend, "out");
    assert.ok(out[0]!.ratio > 1.15);
  });
  it("天數不足回空", () => {
    assert.deepEqual(sectorRotation([{ sector: "A", days: [["d1", 1]] }]), []);
  });
});

describe("美股產業 ETF", () => {
  it("相對大盤與量比", () => {
    const etf = Array.from({ length: 30 }, (_, i) => ({ c: 100 + i, v: i >= 25 ? 200 : 100 }));
    const bench = Array.from({ length: 30 }, () => ({ c: 100 }));
    const f = etfFlow({ symbol: "SMH", name: "半導體" }, etf, bench);
    assert.ok((f.rel20 ?? 0) > 0);
    assert.ok((f.rel5 ?? 0) > 0);
    assert.ok((f.volRatio ?? 0) > 1.4);
    assert.equal(etfFlow({ symbol: "X", name: "x" }, etf.slice(0, 3), bench.slice(0, 3)).rel5, null);
  });
});
