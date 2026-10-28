export const SECTORS = [
  "半導體",
  "電子",
  "電腦",
  "金融",
  "航運",
  "通信",
  "塑膠",
  "食品",
  "光電",
  "水泥",
  "鋼鐵",
  "汽車",
  "電機",
  "其他",
] as const;

export type Sector = (typeof SECTORS)[number];

export interface UniverseStock {
  code: string;
  name: string;
  sector: Sector;
}

/** Original scanner universe — 49 names, not a live index reconstitution. */
export const UNIVERSE: UniverseStock[] = [
  { code: "1101", name: "台泥", sector: "水泥" },
  { code: "1216", name: "統一", sector: "食品" },
  { code: "1301", name: "台塑", sector: "塑膠" },
  { code: "1303", name: "南亞", sector: "塑膠" },
  { code: "1326", name: "台化", sector: "塑膠" },
  { code: "1402", name: "遠東新", sector: "其他" },
  { code: "1504", name: "東元", sector: "電機" },
  { code: "2002", name: "中鋼", sector: "鋼鐵" },
  { code: "2207", name: "和泰車", sector: "汽車" },
  { code: "2301", name: "光寶科", sector: "電子" },
  { code: "2303", name: "聯電", sector: "半導體" },
  { code: "2308", name: "台達電", sector: "電子" },
  { code: "2317", name: "鴻海", sector: "電子" },
  { code: "2327", name: "國巨", sector: "電子" },
  { code: "2330", name: "台積電", sector: "半導體" },
  { code: "2357", name: "華碩", sector: "電腦" },
  { code: "2379", name: "瑞昱", sector: "半導體" },
  { code: "2382", name: "廣達", sector: "電腦" },
  { code: "2395", name: "研華", sector: "電腦" },
  { code: "2408", name: "南亞科", sector: "半導體" },
  { code: "2412", name: "中華電", sector: "通信" },
  { code: "2454", name: "聯發科", sector: "半導體" },
  { code: "2603", name: "長榮", sector: "航運" },
  { code: "2609", name: "陽明", sector: "航運" },
  { code: "2615", name: "萬海", sector: "航運" },
  { code: "2801", name: "彰銀", sector: "金融" },
  { code: "2880", name: "華南金", sector: "金融" },
  { code: "2881", name: "富邦金", sector: "金融" },
  { code: "2882", name: "國泰金", sector: "金融" },
  { code: "2884", name: "玉山金", sector: "金融" },
  { code: "2885", name: "元大金", sector: "金融" },
  { code: "2886", name: "兆豐金", sector: "金融" },
  { code: "2887", name: "台新金", sector: "金融" },
  { code: "2891", name: "中信金", sector: "金融" },
  { code: "2892", name: "第一金", sector: "金融" },
  { code: "2912", name: "統一超", sector: "食品" },
  { code: "3008", name: "大立光", sector: "光電" },
  { code: "3034", name: "聯詠", sector: "半導體" },
  { code: "3037", name: "欣興", sector: "電子" },
  { code: "3045", name: "台灣大", sector: "通信" },
  { code: "3231", name: "緯創", sector: "電腦" },
  { code: "3661", name: "世芯-KY", sector: "半導體" },
  { code: "3711", name: "日月光投控", sector: "半導體" },
  { code: "4904", name: "遠傳", sector: "通信" },
  { code: "5871", name: "中租-KY", sector: "其他" },
  { code: "5880", name: "合庫金", sector: "金融" },
  { code: "6505", name: "台塑化", sector: "塑膠" },
  { code: "6669", name: "緯穎", sector: "電腦" },
  { code: "9910", name: "豐泰", sector: "其他" },
];

export const BENCHMARK = { code: "0050", name: "元大台灣50" };
