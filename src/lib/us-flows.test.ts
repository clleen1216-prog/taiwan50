import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addOptionTotals,
  changePct,
  EMPTY_OPTIONS,
  filedInTime,
  holdingsUsableFrom,
  latestQuarterAsOf,
  matchRule,
  normalizeSecDate,
  parseFinraShortVol,
  pickCusips,
  pickExpiries,
  ratio,
  shortFeaturesAt,
} from "./us-flows.ts";

const FINRA = `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
20261030|NVDA|1000|10|4000|B,Q,N
20261030|AAPL|500|0|2500|B,Q,N
20261030|ZZZZ|5|0|10|B,Q,N
20261030|BAD|x|0|0|N
1234`;

describe("FINRA 空單量", () => {
  it("只取需要的標的、轉日期、略過壞行與筆數行", () => {
    const rows = parseFinraShortVol(FINRA, new Set(["NVDA", "AAPL", "BAD"]));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { date: "2026-10-30", symbol: "NVDA", shortVol: 1000, exemptVol: 10, totalVol: 4000 });
  });
  it("欄位不符要報錯而不是默默回空", () => {
    assert.throws(() => parseFinraShortVol("a|b\n1|2", new Set(["X"])));
  });
  it("空單比與 z 值只用當天以前的資料", () => {
    const series = Array.from({ length: 70 }, (_, i) => ({ shortVol: 400 + (i % 5) * 10, totalVol: 1000 }));
    series.push({ shortVol: 700, totalVol: 1000 });
    const f = shortFeaturesAt(series, 70)!;
    assert.equal(f.shortRatio, 0.7);
    assert.ok(f.shortZ60! > 3);
    const early = shortFeaturesAt(series, 10)!;
    assert.equal(early.shortZ60, null);
  });
});

describe("選擇權 Put/Call", () => {
  it("加總成交量與未平倉，缺值當 0", () => {
    const t = addOptionTotals(EMPTY_OPTIONS, [{ volume: 10, openInterest: 100 }, { volume: null }], [{ volume: 30, openInterest: 50 }]);
    assert.deepEqual(t, { callVol: 10, putVol: 30, callOi: 100, putOi: 50, expiries: 1 });
    assert.equal(ratio(t.putVol, t.callVol), 3);
    assert.equal(ratio(1, 0), null);
  });
  it("只取 45 天內最近 4 個到期日", () => {
    const now = Date.UTC(2026, 10, 2);
    const day = (n: number) => Math.floor(now / 1000) + n * 86400;
    assert.deepEqual(pickExpiries([day(90), day(3), day(10), day(17), day(24), day(31), day(-5)], now), [day(3), day(10), day(17), day(24)]);
  });
});

describe("13F", () => {
  it("日期格式與期限", () => {
    assert.equal(normalizeSecDate("31-DEC-2025"), "2025-12-31");
    assert.equal(normalizeSecDate("2025-12-31"), "2025-12-31");
    assert.equal(normalizeSecDate("garbage"), null);
    assert.equal(holdingsUsableFrom("2025-12-31"), "2026-02-15");
    assert.equal(filedInTime({ accession: "a", filedOn: "2026-02-14", type: "13F-HR", quarterEnd: "2025-12-31" }), true);
    assert.equal(filedInTime({ accession: "a", filedOn: "2026-02-15", type: "13F-HR", quarterEnd: "2025-12-31" }), false);
    assert.equal(filedInTime({ accession: "a", filedOn: "2026-01-10", type: "13F-HR/A", quarterEnd: "2025-12-31" }), false);
  });
  it("依名稱規則歸戶並挑出市值最大的 CUSIP", () => {
    const rules = [{ symbol: "NVDA", name: /^NVIDIA/ }, { symbol: "GOOGL", name: /^ALPHABET/, title: /CL A|CLASS A/ }];
    assert.equal(matchRule(rules, "Nvidia Corporation", "COM"), "NVDA");
    assert.equal(matchRule(rules, "ALPHABET INC", "CAP STK CL C"), null);
    assert.equal(matchRule(rules, "ALPHABET INC", "CAP STK CL A"), "GOOGL");
    const { chosen, alternates } = pickCusips(new Map([["NVDA|AAA", 5e9], ["NVDA|BBB", 1e6]]));
    assert.equal(chosen.get("NVDA"), "AAA");
    assert.equal(alternates.get("NVDA")![0], "BBB(1M)");
  });
  it("只用已公開的季度，並計算季變化", () => {
    const rows = [
      { quarter_end: "2025-09-30", usable_from: "2025-11-15", shares: 100 },
      { quarter_end: "2025-12-31", usable_from: "2026-02-15", shares: 120 },
    ];
    assert.equal(latestQuarterAsOf(rows, "2025-11-14"), null);
    assert.equal(latestQuarterAsOf(rows, "2026-01-20")!.cur.shares, 100);
    const got = latestQuarterAsOf(rows, "2026-03-01")!;
    assert.equal(got.cur.shares, 120);
    assert.equal(changePct(got.cur.shares, got.prev!.shares), 20);
    assert.equal(changePct(5, 0), null);
  });
});
