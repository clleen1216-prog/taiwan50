import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, earningsDatesFrom8K, holderAsOf, insiderAsOf, isWednesday, liquidityAsOf, nextOnOrAfter, parseMarginDay,
} from "./backfill.ts";

describe("日期工具", () => {
  it("加減日與星期三", () => {
    assert.equal(addDays("2026-10-30", 3), "2026-11-02");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(isWednesday("2026-10-28"), true);
    assert.equal(isWednesday("2026-10-29"), false);
  });
});

describe("集保週報不洩漏未來", () => {
  const series: Array<[string, number]> = [
    ["2026-10-02", 69.0], ["2026-10-09", 69.4], ["2026-10-16", 69.9], ["2026-10-23", 70.5],
  ];
  it("結算日當天（週五）看不到該週，下週一才看得到", () => {
    assert.equal(holderAsOf(series, "2026-10-23")?.date, "2026-10-16");
    assert.equal(holderAsOf(series, "2026-10-26")?.date, "2026-10-23");
    assert.equal(holderAsOf(series, "2026-10-26")?.streak, 3);
    assert.equal(holderAsOf(series, "2026-10-02"), null);
  });
});

describe("融資融券歷史解析", () => {
  const fields = ["代號", "名稱", "買進", "賣出", "現金償還", "前日餘額", "今日餘額", "限額", "買進", "賣出", "現券償還", "前日餘額", "今日餘額", "限額", "資券互抵", "註記"];
  const row = ["2330", "台積電", "1", "2", "3", "10,000", "10,300", "50,000", "1", "2", "3", "480", "500", "9,999", "0", ""];
  it("tables 格式：第 1 個今日餘額是融資、第 2 個是融券", () => {
    const m = parseMarginDay({ tables: [{ fields: ["項目"], data: [["x"]] }, { fields, data: [row] }] });
    assert.deepEqual(m.get("2330"), { marginBal: 10300, marginPrev: 10000, marginLimit: 50000, shortBal: 500, shortPrev: 480 });
  });
  it("舊式頂層 fields/data 也可；格式不符回空", () => {
    assert.equal(parseMarginDay({ fields, data: [row] }).size, 1);
    assert.equal(parseMarginDay({ tables: [{ fields: ["a"], data: [["b"]] }] }).size, 0);
    assert.equal(parseMarginDay({}).size, 0);
  });
});

describe("8-K 財報日", () => {
  it("只取 8-K 且 items 含 2.02", () => {
    const dates = earningsDatesFrom8K({
      form: ["8-K", "4", "8-K", "8-K", "8-K"],
      filingDate: ["2026-08-27", "2026-09-01", "2026-06-01", "2026-05-28", "2026-08-27"],
      items: ["2.02,9.01", "", "5.07", "2.02", "2.02,9.01"],
    });
    assert.deepEqual(dates, ["2026-05-28", "2026-08-27"]);
    assert.equal(nextOnOrAfter(dates, "2026-06-01"), "2026-08-27");
    assert.equal(nextOnOrAfter(dates, "2026-08-27"), "2026-08-27");
    assert.equal(nextOnOrAfter(dates, "2026-09-01"), null);
  });
});

describe("內部人以申報日為準", () => {
  const buy = { owner: "A", title: "CFO", isOfficer: true, isDirector: false, date: "2026-10-10", shares: 5000, price: 100, filed: "2026-10-14" };
  const now = Date.parse("2026-10-15T21:00:00Z");
  it("申報前看不到；覆蓋起點不足 30 天回 null（未知）", () => {
    assert.equal(insiderAsOf([buy], "2026-01-01", "2026-10-15", now)?.hasBought, true);
    assert.equal(insiderAsOf([buy], "2026-01-01", "2026-10-13", now)?.hasBought, false);
    assert.equal(insiderAsOf([buy], "2026-10-01", "2026-10-15", now), null);
    assert.equal(insiderAsOf([buy], null, "2026-10-15", now), null);
  });
});

describe("流動性發布時間差", () => {
  const weeks = ["2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"];
  const walcl = weeks.map((d): [string, number] => [d, 6_700_000]);
  const tga = weeks.map((d): [string, number] => [d, 800_000]);
  const rrp = weeks.map((d): [string, number] => [d, 10]);
  it("週三水位要到週五才算可見", () => {
    assert.equal(liquidityAsOf(walcl, tga, rrp, "2026-10-29").net.date, "2026-10-21");
    assert.equal(liquidityAsOf(walcl, tga, rrp, "2026-10-30").net.date, "2026-10-28");
  });
});
