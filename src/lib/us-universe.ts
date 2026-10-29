export interface UsStock {
  symbol: string;
  name: string;
  sector: string;
  /** 外國發行人（20-F / 6-K）不需要申報 Form 4 */
  foreignIssuer?: boolean;
}

export const US_BENCHMARK = { symbol: "SPY", name: "SPDR S&P 500" };

/** 原美股腳本的核心監控清單 */
export const US_UNIVERSE: UsStock[] = [
  { symbol: "NVDA", name: "輝達", sector: "半導體" },
  { symbol: "MU", name: "美光", sector: "半導體" },
  { symbol: "AMD", name: "超微", sector: "半導體" },
  { symbol: "ASML", name: "艾司摩爾", sector: "半導體設備", foreignIssuer: true },
  { symbol: "TSM", name: "台積電 ADR", sector: "半導體", foreignIssuer: true },
  { symbol: "INTC", name: "英特爾", sector: "半導體" },
  { symbol: "AAPL", name: "蘋果", sector: "科技巨頭" },
  { symbol: "GOOGL", name: "Alphabet", sector: "科技巨頭" },
  { symbol: "MSFT", name: "微軟", sector: "科技巨頭" },
  { symbol: "AMZN", name: "亞馬遜", sector: "科技巨頭" },
  { symbol: "ORCL", name: "甲骨文", sector: "軟體雲端" },
];

/** 美股產業資金輪動：用產業 ETF 對 SPY 的相對強弱與量能 */
export const US_SECTOR_ETFS = [
  { symbol: "SMH", name: "半導體" },
  { symbol: "XLK", name: "科技" },
  { symbol: "IGV", name: "軟體" },
  { symbol: "QQQ", name: "那斯達克 100" },
] as const;
