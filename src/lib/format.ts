const WEEKDAY: Record<string, string> = {
  Mon: "週一",
  Tue: "週二",
  Wed: "週三",
  Thu: "週四",
  Fri: "週五",
  Sat: "週六",
  Sun: "週日",
};

function taipeiParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

export function taipeiClock(ms: number) {
  const p = taipeiParts(ms);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

export function taipeiDay(ms: number) {
  const p = taipeiParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

export function taipeiWeekday(ms: number) {
  const short = taipeiParts(ms).weekday;
  return {
    short,
    label: WEEKDAY[short] ?? short,
    isWednesday: short === "Wed",
  };
}

export function fmtPrice(value: number) {
  const digits = value >= 1000 ? 1 : 2;
  return value.toLocaleString("zh-TW", {
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(value: number, digits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function fmtLots(shares: number) {
  const lots = shares / 1000;
  const sign = lots > 0 ? "+" : "";
  const abs = Math.abs(lots);
  if (abs >= 10000) return `${sign}${(lots / 10000).toFixed(2)}萬張`;
  return `${sign}${Math.round(lots).toLocaleString("zh-TW")}張`;
}

export function toneClass(value: number) {
  if (value > 0) return "text-up";
  if (value < 0) return "text-down";
  return "text-muted";
}
