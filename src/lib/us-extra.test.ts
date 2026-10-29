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
