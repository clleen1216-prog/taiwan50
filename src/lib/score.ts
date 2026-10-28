export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** [time, open, high, low, close, volume, ma20, ma60] */
export type WireBar = [number, number, number, number, number, number, number, number];

export type ChipSide = "dual-buy" | "single-buy" | "split" | "dual-sell" | "neutral" | "unknown";

export type SopKind = "breakout" | "fake" | "coil" | "watch" | "trend" | "weak" | "flat";

export interface CheckItem {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScoreInput {
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  volMa20: number;
  foreign: number | null;
  trust: number | null;
  settlement: boolean;
  ret20: number | null;
  benchRet20: number | null;
}

export interface ScoreOutput {
  spreadPct: number;
  volRatio: number;
  upperShadow: number;
  bearish: boolean;
  inGate: boolean;
  tight: boolean;
  sopScore: number | null;
  sopLabel: string;
  sopKind: SopKind;
  flagshipScore: number;
  chip: ChipSide;
  chipLabel: string;
  bullStack: boolean;
  settlementPenalty: boolean;
  rs20: number | null;
  notes: string[];
  checks: CheckItem[];
}

export function rollingMean(values: number[], window: number) {
  const out: Array<number | null> = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] ?? 0;
    if (i >= window) sum -= values[i - window] ?? 0;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

export function trailingReturn(closes: number[], days: number) {
  const last = closes.length - 1;
  if (last < days) return null;
  const base = closes[last - days];
  if (!base) return null;
  return (closes[last]! / base - 1) * 100;
}

function roundTo(value: number, digits: number) {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function chipOf(foreign: number | null, trust: number | null): { chip: ChipSide; label: string } {
  if (foreign == null || trust == null) return { chip: "unknown", label: "籌碼未取得" };
  if (foreign > 0 && trust > 0) return { chip: "dual-buy", label: "雙法人買超" };
  if (foreign < 0 && trust < 0) return { chip: "dual-sell", label: "雙法人賣超" };
  if ((foreign > 0 && trust < 0) || (foreign < 0 && trust > 0)) {
    return { chip: "split", label: "法人分歧" };
  }
  if (foreign > 0 || trust > 0) return { chip: "single-buy", label: "單法人買超" };
  return { chip: "neutral", label: "籌碼中立" };
}

export function scoreStock(input: ScoreInput): ScoreOutput {
  const { close, open, high, low, volume, ma5, ma10, ma20, ma60, volMa20 } = input;
  const maValues = [ma5, ma10, ma20, ma60];
  const spread = (Math.max(...maValues) - Math.min(...maValues)) / close;
  const inGate = spread < 0.05;
  const tight = spread < 0.025;
  const volRatio = volMa20 > 0 ? volume / volMa20 : 0;
  const span = high - low;
  const upperShadow = span > 0 ? (high - Math.max(close, open)) / span : 0;
  const trap = upperShadow > 0.4;
  const bearish = close < open;
  const bullStack = ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
  const aboveMa20 = close > ma20;
  const { chip, label: chipLabel } = chipOf(input.foreign, input.trust);

  let sop = 70;
  let kind: SopKind = "watch";
  if (tight) sop += 10;

  if (volRatio >= 1.5 && aboveMa20) {
    if (trap || bearish) {
      kind = "fake";
      sop -= 30;
    } else {
      kind = "breakout";
      sop += 20;
    }
  } else if (volRatio < 0.8) {
    kind = "coil";
    sop += 5;
  }

  if (chip === "dual-buy") sop += 15;
  else if (chip === "single-buy" || chip === "split") sop += 5;
  else if (chip === "dual-sell") sop -= 15;

  const settlementPenalty = inGate && input.settlement && kind === "breakout";
  if (settlementPenalty) sop -= 10;

  let sopLabel = "盤整觀察";
  if (kind === "breakout") sopLabel = settlementPenalty ? "強勢發動 · 結算日" : "強勢發動";
  else if (kind === "fake") sopLabel = "假突破警戒";
  else if (kind === "coil") sopLabel = "量縮等待";

  if (!inGate) {
    sop = Number.NaN;
    if (kind === "breakout") sopLabel = "放量未糾結";
    else if (kind === "fake") sopLabel = "假突破 · 未入閘";
    else if (close < ma60) {
      kind = "weak";
      sopLabel = "弱勢";
    } else if (bullStack && aboveMa20) {
      kind = "trend";
      sopLabel = "趨勢行進";
    } else {
      kind = "flat";
      sopLabel = "未入閘";
    }
  }

  const notes: string[] = [];
  let flagship = 40;
  if (tight) {
    flagship += 18;
    notes.push("四條均線極度糾結，價差不到 2.5%");
  } else if (inGate) {
    flagship += 12;
    notes.push("均線糾結入閘，價差小於 5%");
  } else if (spread < 0.08) {
    flagship += 5;
    notes.push("均線開始收斂，但還沒進原腳本");
  } else {
    notes.push("均線發散，原腳本直接跳過");
  }

  if (bullStack) {
    flagship += 8;
    notes.push("短中長期多頭排列");
  }
  flagship += aboveMa20 ? 5 : -5;
  flagship += close > ma60 ? 5 : -6;
  if (!aboveMa20) notes.push("收在月線下方");
  if (close <= ma60) notes.push("收在季線下方");

  if (volRatio >= 1.5 && aboveMa20) {
    if (trap || bearish) {
      flagship -= 18;
      notes.push(trap ? "爆量但上影過長，像假突破" : "爆量收黑，量價不乾淨");
    } else {
      flagship += 16;
      notes.push("站上月線且實體扎實，量能超過 1.5 倍");
    }
  } else if (volRatio < 0.8 && inGate) {
    flagship += 6;
    notes.push("糾結同時量縮，還在沉澱");
  }

  if (chip === "dual-buy") {
    flagship += 12;
    notes.push("外資與投信同一天買超");
  } else if (chip === "single-buy") {
    flagship += 5;
    notes.push("只有一邊法人在買");
  } else if (chip === "split") {
    flagship += 2;
    notes.push("外資與投信方向相反");
  } else if (chip === "dual-sell") {
    flagship -= 12;
    notes.push("外資與投信同步賣超");
  }

  const rs20 =
    input.ret20 != null && input.benchRet20 != null ? input.ret20 - input.benchRet20 : null;
  if (rs20 != null && rs20 >= 3) {
    flagship += 6;
    notes.push("近 20 日比 0050 強");
  } else if (rs20 != null && rs20 <= -3) {
    flagship -= 4;
    notes.push("近 20 日比 0050 弱");
  }

  if (settlementPenalty) {
    flagship -= 8;
    notes.push("週三結算，強勢追價扣點");
  }

  const flagshipScore = Math.max(0, Math.min(100, Math.round(flagship)));

  const checks: CheckItem[] = [
    { label: "均線糾結 < 5%", pass: inGate, detail: `${(spread * 100).toFixed(2)}%` },
    { label: "極度緊密 < 2.5%", pass: tight, detail: `${(spread * 100).toFixed(2)}%` },
    { label: "收盤站上月線", pass: aboveMa20, detail: ma20.toFixed(2) },
    { label: "收盤站上季線", pass: close > ma60, detail: ma60.toFixed(2) },
    { label: "多頭排列", pass: bullStack, detail: bullStack ? "MA5 > 10 > 20 > 60" : "尚未" },
    { label: "量能 ≥ 1.5 倍", pass: volRatio >= 1.5, detail: `${volRatio.toFixed(2)}x` },
    {
      label: "K 棒乾淨",
      pass: !(trap || bearish),
      detail: trap ? `上影 ${(upperShadow * 100).toFixed(0)}%` : bearish ? "收黑" : "實體沒有長上影",
    },
    {
      label: "外資買超",
      pass: (input.foreign ?? 0) > 0 && input.foreign != null,
      detail: input.foreign == null ? "無資料" : input.foreign > 0 ? "買超" : "未買超",
    },
    {
      label: "投信買超",
      pass: (input.trust ?? 0) > 0 && input.trust != null,
      detail: input.trust == null ? "無資料" : input.trust > 0 ? "買超" : "未買超",
    },
    {
      label: "結算日不追突破",
      pass: !settlementPenalty,
      detail: !input.settlement ? "非週三" : settlementPenalty ? "已扣點" : "週三，這檔不是追價",
    },
  ];

  return {
    spreadPct: roundTo(spread * 100, 2),
    volRatio: roundTo(volRatio, 2),
    upperShadow: roundTo(upperShadow, 3),
    bearish,
    inGate,
    tight,
    sopScore: inGate ? Math.round(sop) : null,
    sopLabel,
    sopKind: kind,
    flagshipScore,
    chip,
    chipLabel,
    bullStack,
    settlementPenalty,
    rs20: rs20 == null ? null : roundTo(rs20, 2),
    notes: notes.slice(0, 6),
    checks,
  };
}
