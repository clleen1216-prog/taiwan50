/** 美股附加訊號的純函式：Form 4 內部人買進、FRED 流動性、財報日倒數。不碰網路，方便測試。 */

export interface InsiderBuy {
  owner: string;
  title: string;
  isOfficer: boolean;
  isDirector: boolean;
  date: string;
  shares: number;
  price: number;
}

export interface InsiderSummary {
  hasBought: boolean;
  totalUsd: number;
  buyers: string[];
  note: string;
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i"));
  return m ? m[1]!.trim() : null;
}

function valueOf(block: string, name: string): string | null {
  const inner = tag(block, name);
  if (inner == null) return null;
  return tag(inner, "value") ?? inner;
}

function truthy(v: string | null) {
  return v === "1" || v?.toLowerCase() === "true";
}

/** 解析一份 Form 4 XML，只回傳「公開市場買進 (code P)」的非衍生性交易。 */
export function parseForm4Purchases(xml: string): InsiderBuy[] {
  const ownerBlock = tag(xml, "reportingOwner") ?? "";
  const owner = tag(ownerBlock, "rptOwnerName") ?? "內部人";
  const rel = tag(ownerBlock, "reportingOwnerRelationship") ?? "";
  const isOfficer = truthy(tag(rel, "isOfficer"));
  const isDirector = truthy(tag(rel, "isDirector"));
  const title = tag(rel, "officerTitle") ?? (isDirector ? "Director" : "");
  const out: InsiderBuy[] = [];
  const re = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1]!;
    const code = tag(tag(block, "transactionCoding") ?? "", "transactionCode");
    if (code !== "P") continue;
    const shares = Number(valueOf(block, "transactionShares"));
    const price = Number(valueOf(block, "transactionPricePerShare"));
    const date = valueOf(block, "transactionDate") ?? "";
    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) continue;
    out.push({ owner, title, isOfficer, isDirector, date: date.slice(0, 10), shares, price });
  }
  return out;
}

function usd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(value / 1000)}K`;
}

/** 近 windowDays 天內、官員或董事的公開市場買進，總額達 minUsd 才算「內部人買進」。 */
export function summarizeInsiders(
  buys: InsiderBuy[],
  now: number,
  windowDays = 30,
  minUsd = 100_000,
): InsiderSummary {
  const cutoff = now - windowDays * 86_400_000;
  const recent = buys.filter(
    (b) => (b.isOfficer || b.isDirector) && Date.parse(b.date) >= cutoff,
  );
  const totalUsd = recent.reduce((sum, b) => sum + b.shares * b.price, 0);
  const buyers = [...new Set(recent.map((b) => `${b.owner}${b.title ? `（${b.title}）` : ""}`))];
  if (totalUsd >= minUsd) {
    return {
      hasBought: true,
      totalUsd: Math.round(totalUsd),
      buyers,
      note: `近 ${windowDays} 天公開市場買進 ${usd(totalUsd)}：${buyers.slice(0, 2).join("、")}`,
    };
  }
  if (totalUsd > 0) {
    return {
      hasBought: false,
      totalUsd: Math.round(totalUsd),
      buyers,
      note: `有內部人買進但只有 ${usd(totalUsd)}，未達 ${usd(minUsd)} 門檻`,
    };
  }
  return { hasBought: false, totalUsd: 0, buyers: [], note: `近 ${windowDays} 天無內部人公開市場買進` };
}

export interface Liquidity {
  value: number;
  prev: number;
  changeAbs: number;
  status: "tightening" | "easing" | "neutral" | "unknown";
  label: string;
}

/** FRED fredgraph.csv → [[date, value]]，"." 代表缺值。 */
export function parseFredCsv(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    if (!date || raw == null || raw.trim() === "." || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push([date.trim(), value]);
  }
  return out;
}

/**
 * ON RRP 餘額（單位：十億美元）。餘額很低時百分比變動會被小基數放大，
 * 所以改看絕對變動：近 5 個觀察值增加 ≥ 50B 視為游資回流隔夜逆回購（收緊），減少 ≥ 50B 視為釋放。
 */
export function liquidityFrom(series: Array<[string, number]>, thresholdB = 50): Liquidity {
  if (series.length < 6) {
    return { value: 0, prev: 0, changeAbs: 0, status: "unknown", label: "流動性資料未取得" };
  }
  const value = series[series.length - 1]![1];
  const prev = series[series.length - 6]![1];
  const changeAbs = value - prev;
  if (changeAbs >= thresholdB) {
    return { value, prev, changeAbs, status: "tightening", label: "流動性收緊中" };
  }
  if (changeAbs <= -thresholdB) {
    return { value, prev, changeAbs, status: "easing", label: "流動性釋放中" };
  }
  return { value, prev, changeAbs, status: "neutral", label: "流動性中立" };
}

/** 以日期（UTC 日）計算距離財報幾天；財報日已過回傳負數。 */
export function daysUntil(earningsMs: number, nowMs: number): number {
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  return day(earningsMs) - day(nowMs);
}

// ---------- 淨流動性：聯準會資產 − 財政部帳戶 (TGA) − 隔夜逆回購 (ON RRP) ----------

export interface NetLiquidity {
  /** 十億美元 */
  value: number;
  prev: number;
  changeAbs: number;
  fedAssets: number;
  tga: number;
  rrp: number;
  date: string;
  status: "easing" | "tightening" | "neutral" | "unknown";
  label: string;
}

/**
 * WALCL（聯準會總資產）與 WTREGEN（TGA）是每週三的水位，單位百萬美元；
 * RRPONTSYD 是每日、單位十億美元。逐週對齊後，近 4 週淨流動性增加 ≥ 100B 視為擴張，減少 ≥ 100B 視為收縮。
 */
export function netLiquidityFrom(
  walcl: Array<[string, number]>,
  tga: Array<[string, number]>,
  rrp: Array<[string, number]>,
  thresholdB = 100,
): NetLiquidity {
  const unknown: NetLiquidity = {
    value: 0, prev: 0, changeAbs: 0, fedAssets: 0, tga: 0, rrp: 0, date: "",
    status: "unknown", label: "淨流動性資料未取得",
  };
  const tgaMap = new Map(tga);
  const rrpSorted = [...rrp].sort((a, b) => a[0].localeCompare(b[0]));
  // 單位防呆：TGA 正常是百萬美元（約 80 萬），若數字小於 2 萬就當作已經是十億美元
  const tgaScale = tga.length > 0 && Math.max(...tga.map((t) => t[1])) < 20_000 ? 1 : 1000;
  const points: Array<{ date: string; net: number; fed: number; tga: number; rrp: number }> = [];
  for (const [date, fedM] of walcl) {
    const tgaV = tgaMap.get(date);
    if (tgaV == null) continue;
    let rrpV: number | null = null;
    for (const [d, v] of rrpSorted) {
      if (d <= date) rrpV = v;
      else break;
    }
    if (rrpV == null) continue;
    const fed = fedM / 1000;
    const t = tgaV / tgaScale;
    points.push({ date, net: fed - t - rrpV, fed, tga: t, rrp: rrpV });
  }
  if (points.length < 5) return unknown;
  const last = points[points.length - 1]!;
  const prev = points[points.length - 5]!;
  const changeAbs = last.net - prev.net;
  const status = changeAbs >= thresholdB ? "easing" : changeAbs <= -thresholdB ? "tightening" : "neutral";
  return {
    value: last.net,
    prev: prev.net,
    changeAbs,
    fedAssets: last.fed,
    tga: last.tga,
    rrp: last.rrp,
    date: last.date,
    status,
    label: status === "easing" ? "淨流動性擴張" : status === "tightening" ? "淨流動性收縮" : "淨流動性持平",
  };
}

// ---------- 財報週預期波動（選擇權跨式報價） ----------

export interface OptionQuote {
  strike: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
}

export interface ExpectedMove {
  strike: number;
  movePct: number;
  /** 年化隱含波動率 %，兩邊平均 */
  iv: number | null;
}

/** 財報日之後（嚴格晚於財報當天）最近的到期日；expirations 是 epoch 秒。 */
export function pickExpiry(expirations: number[], earningsMs: number): number | null {
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  const sorted = [...expirations].sort((a, b) => a - b);
  return sorted.find((sec) => day(sec * 1000) > day(earningsMs)) ?? null;
}

function mid(q: OptionQuote): number | null {
  if (q.bid && q.ask && q.bid > 0 && q.ask >= q.bid) return (q.bid + q.ask) / 2;
  return q.lastPrice && q.lastPrice > 0 ? q.lastPrice : null;
}

/** 履約價最接近現價的買權 + 賣權中價 ÷ 現價 = 市場預期的財報前後波動幅度。 */
export function expectedMoveFrom(calls: OptionQuote[], puts: OptionQuote[], spot: number): ExpectedMove | null {
  if (!(spot > 0)) return null;
  const putByStrike = new Map(puts.map((p) => [p.strike, p]));
  let best: { call: OptionQuote; put: OptionQuote } | null = null;
  for (const call of calls) {
    const put = putByStrike.get(call.strike);
    if (!put) continue;
    if (!best || Math.abs(call.strike - spot) < Math.abs(best.call.strike - spot)) best = { call, put };
  }
  if (!best) return null;
  const c = mid(best.call);
  const p = mid(best.put);
  if (c == null || p == null) return null;
  const ivs = [best.call.impliedVolatility, best.put.impliedVolatility].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  return {
    strike: best.call.strike,
    movePct: Math.round(((c + p) / spot) * 10000) / 100,
    iv: ivs.length ? Math.round((ivs.reduce((s, v) => s + v, 0) / ivs.length) * 1000) / 10 : null,
  };
}
