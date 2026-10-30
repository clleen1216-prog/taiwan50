import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  daysUntil,
  liquidityFrom,
  parseForm4Purchases,
  parseFredCsv,
  summarizeInsiders,
} from "./us-extra.ts";

const FORM4 = (code: string, shares: number, price: number, officer = "1", title = "Chief Financial Officer") => `
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector><isOfficer>${officer}</isOfficer><officerTitle>${title}</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-20</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${shares}</value></transactionShares>
        <transactionPricePerShare><value>${price}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const NOW = Date.parse("2026-10-29T00:00:00Z");

describe("Form 4", () => {
  it("只取公開市場買進 P，賣出 S / 授予 A / 行權 M 不算", () => {
    assert.equal(parseForm4Purchases(FORM4("P", 5000, 100)).length, 1);
    for (const code of ["S", "A", "M", "F", "G"]) {
      assert.equal(parseForm4Purchases(FORM4(code, 5000, 100)).length, 0, code);
    }
  });

  it("解析身分與金額，總額達門檻才算買進", () => {
    const buys = parseForm4Purchases(FORM4("P", 5000, 100));
    assert.equal(buys[0]!.owner, "DOE JANE");
    assert.equal(buys[0]!.title, "Chief Financial Officer");
    const big = summarizeInsiders(buys, NOW);
    assert.equal(big.hasBought, true);
    assert.equal(big.totalUsd, 500_000);
    const small = summarizeInsiders(parseForm4Purchases(FORM4("P", 100, 100)), NOW);
    assert.equal(small.hasBought, false);
    assert.ok(small.totalUsd > 0);
  });

  it("超過 30 天的買進不算", () => {
    const old = parseForm4Purchases(FORM4("P", 5000, 100)).map((b) => ({ ...b, date: "2026-08-01" }));
    assert.equal(summarizeInsiders(old, NOW).hasBought, false);
  });

  it("非官員非董事（例如 10% 持有人）不算", () => {
    const buys = parseForm4Purchases(FORM4("P", 5000, 100, "0", ""));
    assert.equal(summarizeInsiders(buys, NOW).hasBought, false);
  });
});

describe("FRED 流動性", () => {
  it("略過缺值，並用絕對變動判斷", () => {
    const csv = "observation_date,RRPONTSYD\n" + [
      ["2026-10-20", "10"], ["2026-10-21", "."], ["2026-10-22", "12"], ["2026-10-23", "11"],
      ["2026-10-24", "13"], ["2026-10-27", "14"], ["2026-10-28", "90"],
    ].map((r) => r.join(",")).join("\n");
    const series = parseFredCsv(csv);
    assert.equal(series.length, 6);
    const liq = liquidityFrom(series);
    assert.equal(liq.status, "tightening");
    assert.equal(liq.changeAbs, 80);
  });

  it("小基數不會被百分比放大；資料不足為 unknown；前值為 0 不除以零", () => {
    const flat: Array<[string, number]> = Array.from({ length: 8 }, (_, i) => [`d${i}`, i === 7 ? 3 : 0]);
    assert.equal(liquidityFrom(flat).status, "neutral");
    assert.equal(liquidityFrom([]).status, "unknown");
  });
});

describe("財報日倒數", () => {
  it("以日期計算", () => {
    const earn = Date.parse("2026-11-01T21:00:00Z");
    assert.equal(daysUntil(earn, NOW), 3);
    assert.equal(daysUntil(NOW + 3600_000, NOW), 0);
    assert.equal(daysUntil(NOW - 86_400_000, NOW), -1);
  });
});

import { expectedMoveFrom, netLiquidityFrom, pickExpiry } from "./us-extra.ts";

describe("淨流動性", () => {
  const weeks = ["2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"];
  const walcl = weeks.map((d, i): [string, number] => [d, 6_600_000 + i * 20_000]); // 百萬
  const tga = weeks.map((d, i): [string, number] => [d, 800_000 + i * 40_000]);
  const rrp: Array<[string, number]> = weeks.map((d): [string, number] => [d, 10]);

  it("單位對齊：資產 − TGA − RRP（十億美元）", () => {
    const r = netLiquidityFrom(walcl, tga, rrp);
    assert.equal(r.fedAssets, 6700);
    assert.equal(r.tga, 1000);
    assert.equal(r.value, 6700 - 1000 - 10);
  });
  it("4 週變化超過門檻才算擴張或收縮", () => {
    assert.equal(netLiquidityFrom(walcl, tga, rrp).changeAbs, -80); // 資產 +80B、TGA +160B
    assert.equal(netLiquidityFrom(walcl, tga, rrp).status, "neutral");
    const heavyTga = weeks.map((d, i): [string, number] => [d, 800_000 + i * 60_000]);
    assert.equal(netLiquidityFrom(walcl, heavyTga, rrp).status, "tightening"); // TGA 吸走流動性
    const flatTga = weeks.map((d): [string, number] => [d, 800_000]);
    assert.equal(netLiquidityFrom(walcl, flatTga, rrp).changeAbs, 80);
    assert.equal(netLiquidityFrom(walcl, flatTga, rrp).status, "neutral");
    const bigWalcl = weeks.map((d, i): [string, number] => [d, 6_600_000 + i * 60_000]);
    assert.equal(netLiquidityFrom(bigWalcl, flatTga, rrp).status, "easing");
  });
  it("RRP 取不晚於該週的最近值；資料不足 unknown；TGA 若已是十億美元也能處理", () => {
    const sparseRrp: Array<[string, number]> = [["2026-09-20", 5], ["2026-10-10", 50]];
    const r = netLiquidityFrom(walcl, tga, sparseRrp);
    assert.equal(r.rrp, 50);
    assert.equal(netLiquidityFrom(walcl.slice(0, 3), tga, rrp).status, "unknown");
    const tgaB = weeks.map((d): [string, number] => [d, 800]);
    assert.equal(netLiquidityFrom(walcl, tgaB, rrp).tga, 800);
  });
});

describe("財報週預期波動", () => {
  it("挑財報日之後最近的到期日", () => {
    const earn = Date.parse("2026-10-29T21:00:00Z");
    const exps = [Date.parse("2026-10-29T00:00:00Z"), Date.parse("2026-10-30T00:00:00Z"), Date.parse("2026-11-06T00:00:00Z")].map((ms) => ms / 1000);
    assert.equal(pickExpiry(exps, earn), exps[1]);
    assert.equal(pickExpiry([exps[0]!], earn), null);
  });
  it("ATM 跨式：中價相加 ÷ 現價", () => {
    const calls = [{ strike: 95, bid: 8, ask: 8.2 }, { strike: 100, bid: 4.9, ask: 5.1, impliedVolatility: 0.8 }, { strike: 105, bid: 2, ask: 2.2 }];
    const puts = [{ strike: 95, bid: 1.9, ask: 2.1 }, { strike: 100, bid: 4.4, ask: 4.6, impliedVolatility: 0.7 }];
    const m = expectedMoveFrom(calls, puts, 101)!;
    assert.equal(m.strike, 100);
    assert.equal(m.movePct, 9.41); // (5.0 + 4.5) / 101
    assert.equal(m.iv, 75);
  });
  it("沒有報價或履約價對不上回 null；沒有買賣價時用成交價", () => {
    assert.equal(expectedMoveFrom([], [], 100), null);
    assert.equal(expectedMoveFrom([{ strike: 100 }], [{ strike: 100, lastPrice: 3 }], 100), null);
    assert.equal(expectedMoveFrom([{ strike: 100, lastPrice: 3 }], [{ strike: 100, lastPrice: 3 }], 100)?.movePct, 6);
  });
});
