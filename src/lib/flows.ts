/** 資金動向的純函式：法人連續買賣超、融資融券、類股資金輪動、美股產業 ETF。不碰網路。 */

export interface FlowInfo {
  /** 外資連續買超(+)或賣超(-)的天數 */
  foreignStreak: number;
  trustStreak: number;
  /** 近 N 個交易日合計（股） */
  foreign5d: number;
  trust5d: number;
  days: number;
}

/** 由舊到新的序列，回傳結尾連續同方向的天數（買超為正、賣超為負，0 中斷）。 */
export function computeStreak(values: number[]): number {
  const last = values[values.length - 1];
  if (last == null || last === 0) return 0;
  const sign = last > 0 ? 1 : -1;
  let count = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i]!;
    if (v === 0 || (v > 0 ? 1 : -1) !== sign) break;
    count += 1;
  }
  return sign * count;
}

export function flowFrom(foreign: number[], trust: number[]): FlowInfo {
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  return {
    foreignStreak: computeStreak(foreign),
    trustStreak: computeStreak(trust),
    foreign5d: sum(foreign),
    trust5d: sum(trust),
    days: foreign.length,
  };
}

export type MarginSide = "heating" | "cooling" | "neutral" | "unknown";

export interface MarginInfo {
  /** 融資餘額（張）、單日增減（張）與百分比 */
  marginBal: number;
  marginChange: number;
  marginChangePct: number;
  /** 融資使用率 % = 餘額 / 限額 */
  marginUse: number | null;
  shortBal: number;
  shortChange: number;
  /** 券資比 % = 融券餘額 / 融資餘額 */
  shortRatio: number | null;
  side: MarginSide;
  label: string;
}

/**
 * 單日融資變化搭配當日漲跌的粗略判讀，只用來顯示、不計分：
 * 融資增加 ≥ 2% 且收紅 → 散戶追價；融資減少 ≥ 2% 且沒收黑 → 籌碼沉澱。
 */
export function marginFrom(
  raw: {
    marginBal: number;
    marginPrev: number;
    marginLimit: number | null;
    shortBal: number;
    shortPrev: number;
  },
  changePct: number,
): MarginInfo {
  const marginChange = raw.marginBal - raw.marginPrev;
  const marginChangePct = raw.marginPrev > 0 ? (marginChange / raw.marginPrev) * 100 : 0;
  let side: MarginSide = "neutral";
  let label = "融資持平";
  if (marginChangePct >= 2 && changePct > 0) {
    side = "heating";
    label = "融資追價，留意散戶過熱";
  } else if (marginChangePct <= -2 && changePct >= 0) {
    side = "cooling";
    label = "融資退場、股價撐住，籌碼沉澱";
  }
  return {
    marginBal: raw.marginBal,
    marginChange,
    marginChangePct: Math.round(marginChangePct * 100) / 100,
    marginUse: raw.marginLimit && raw.marginLimit > 0 ? Math.round((raw.marginBal / raw.marginLimit) * 1000) / 10 : null,
    shortBal: raw.shortBal,
    shortChange: raw.shortBal - raw.shortPrev,
    shortRatio: raw.marginBal > 0 ? Math.round((raw.shortBal / raw.marginBal) * 1000) / 10 : null,
    side,
    label,
  };
}

export interface SectorFlow {
  sector: string;
  stocks: number;
  /** 近 5 日、近 20 日平均成交值占觀察名單的比重 (%) */
  share5: number;
  share20: number;
  /** share5 / share20，> 1.15 資金流入、< 0.87 資金流出 */
  ratio: number;
  trend: "in" | "out" | "flat";
}

/**
 * 觀察名單內的類股資金輪動：每天算各類股成交值（收盤 × 量）占名單總成交值的比重，
 * 比較近 5 日與近 20 日平均。這只反映名單內（大型權值股）的相對輪動，不是全市場。
 */
export function sectorRotation(
  items: Array<{ sector: string; days: Array<[string, number]> }>,
  window = 20,
  recent = 5,
): SectorFlow[] {
  const perDay = new Map<string, { total: number; bySector: Map<string, number> }>();
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.sector, (counts.get(item.sector) ?? 0) + 1);
    for (const [day, turnover] of item.days) {
      const entry = perDay.get(day) ?? { total: 0, bySector: new Map<string, number>() };
      entry.total += turnover;
      entry.bySector.set(item.sector, (entry.bySector.get(item.sector) ?? 0) + turnover);
      perDay.set(day, entry);
    }
  }
  const dates = [...perDay.keys()].sort().slice(-window);
  if (dates.length < window) return [];
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const out: SectorFlow[] = [];
  for (const [sector, stocks] of counts) {
    const shares = dates.map((d) => {
      const e = perDay.get(d)!;
      return e.total > 0 ? (e.bySector.get(sector) ?? 0) / e.total : 0;
    });
    const share20 = mean(shares);
    const share5 = mean(shares.slice(-recent));
    const ratio = share20 > 0 ? share5 / share20 : 1;
    out.push({
      sector,
      stocks,
      share5: Math.round(share5 * 1000) / 10,
      share20: Math.round(share20 * 1000) / 10,
      ratio: Math.round(ratio * 100) / 100,
      trend: ratio >= 1.15 ? "in" : ratio <= 0.87 ? "out" : "flat",
    });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

export interface EtfFlow {
  symbol: string;
  name: string;
  /** 近 5 / 20 日相對大盤報酬（百分點） */
  rel5: number | null;
  rel20: number | null;
  /** 近 5 日均量 / 近 20 日均量 */
  volRatio: number | null;
}

function retOver(closes: number[], days: number) {
  const last = closes.length - 1;
  if (last < days) return null;
  const base = closes[last - days];
  return base ? (closes[last]! / base - 1) * 100 : null;
}

function meanOf(values: number[]) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function etfFlow(
  meta: { symbol: string; name: string },
  etf: { c: number; v: number }[],
  bench: { c: number }[],
): EtfFlow {
  const ec = etf.map((b) => b.c);
  const bc = bench.map((b) => b.c);
  const diff = (days: number) => {
    const a = retOver(ec, days);
    const b = retOver(bc, days);
    return a == null || b == null ? null : Math.round((a - b) * 100) / 100;
  };
  const vols = etf.map((b) => b.v);
  const v20 = vols.length >= 20 ? meanOf(vols.slice(-20)) : null;
  const v5 = vols.length >= 5 ? meanOf(vols.slice(-5)) : null;
  return {
    symbol: meta.symbol,
    name: meta.name,
    rel5: diff(5),
    rel20: diff(20),
    volRatio: v20 && v5 ? Math.round((v5 / v20) * 100) / 100 : null,
  };
}
