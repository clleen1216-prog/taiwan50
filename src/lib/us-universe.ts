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
  { symbol: "AVGO", name: "博通", sector: "半導體" },
  { symbol: "QCOM", name: "高通", sector: "半導體" },
  { symbol: "TXN", name: "德州儀器", sector: "半導體" },
  { symbol: "AMAT", name: "應用材料", sector: "半導體設備" },
  { symbol: "LRCX", name: "科林研發", sector: "半導體設備" },
  { symbol: "KLAC", name: "科磊", sector: "半導體設備" },
  { symbol: "ADI", name: "亞德諾", sector: "半導體" },
  { symbol: "META", name: "Meta", sector: "科技巨頭" },
  { symbol: "TSLA", name: "特斯拉", sector: "科技巨頭" },
  { symbol: "NFLX", name: "網飛", sector: "科技巨頭" },
  { symbol: "CRM", name: "賽富時", sector: "軟體雲端" },
  { symbol: "ADBE", name: "Adobe", sector: "軟體雲端" },
  { symbol: "NOW", name: "ServiceNow", sector: "軟體雲端" },
  { symbol: "INTU", name: "財捷", sector: "軟體雲端" },
  { symbol: "CSCO", name: "思科", sector: "科技硬體" },
  { symbol: "IBM", name: "IBM", sector: "科技硬體" },
  { symbol: "DELL", name: "戴爾", sector: "科技硬體" },
  { symbol: "JPM", name: "摩根大通", sector: "金融" },
  { symbol: "BAC", name: "美國銀行", sector: "金融" },
  { symbol: "GS", name: "高盛", sector: "金融" },
  { symbol: "V", name: "Visa", sector: "金融" },
  { symbol: "MA", name: "萬事達", sector: "金融" },
  { symbol: "PYPL", name: "PayPal", sector: "金融" },
  { symbol: "BRK-B", name: "波克夏", sector: "金融" },
  { symbol: "UNH", name: "聯合健康", sector: "醫療" },
  { symbol: "JNJ", name: "嬌生", sector: "醫療" },
  { symbol: "LLY", name: "禮來", sector: "醫療" },
  { symbol: "PFE", name: "輝瑞", sector: "醫療" },
  { symbol: "MRK", name: "默克", sector: "醫療" },
  { symbol: "ABBV", name: "艾伯維", sector: "醫療" },
  { symbol: "TMO", name: "賽默飛", sector: "醫療" },
  { symbol: "WMT", name: "沃爾瑪", sector: "消費" },
  { symbol: "COST", name: "好市多", sector: "消費" },
  { symbol: "HD", name: "家得寶", sector: "消費" },
  { symbol: "NKE", name: "耐吉", sector: "消費" },
  { symbol: "MCD", name: "麥當勞", sector: "消費" },
  { symbol: "KO", name: "可口可樂", sector: "消費" },
  { symbol: "PG", name: "寶僑", sector: "消費" },
  { symbol: "DIS", name: "迪士尼", sector: "消費" },
  { symbol: "XOM", name: "埃克森美孚", sector: "能源" },
  { symbol: "CVX", name: "雪佛龍", sector: "能源" },
  { symbol: "COP", name: "康菲", sector: "能源" },
  { symbol: "CAT", name: "開拓重工", sector: "工業" },
  { symbol: "BA", name: "波音", sector: "工業" },
  { symbol: "GE", name: "奇異", sector: "工業" },
  { symbol: "HON", name: "漢威", sector: "工業" },
  { symbol: "UPS", name: "UPS", sector: "工業" },
  { symbol: "T", name: "AT&T", sector: "通訊" },
  { symbol: "VZ", name: "威瑞森", sector: "通訊" },
];

/** 美股產業資金輪動：用產業 ETF 對 SPY 的相對強弱與量能 */
export const US_SECTOR_ETFS = [
  { symbol: "SMH", name: "半導體" },
  { symbol: "XLK", name: "科技" },
  { symbol: "IGV", name: "軟體" },
  { symbol: "QQQ", name: "那斯達克 100" },
] as const;
