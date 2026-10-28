import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, RefreshCw, Star } from "lucide-react";
import { scanMarket, type ScanResult, type StockRow } from "@/lib/scan";
import { SECTORS } from "@/lib/universe";
import { fmtLots, fmtPct, fmtPrice, taipeiClock, toneClass } from "@/lib/format";
import { cn } from "@/lib/cn";
import { StockPanel } from "@/components/stock-panel";

const WATCH_KEY = "flagship50.watch";

type Lens = "gate" | "all" | "breakout" | "fake" | "coil" | "dual" | "watch";
type SortKey = "flagship" | "sop" | "change" | "spread" | "vol" | "foreign";

const LENSES: { id: Lens; label: string }[] = [
  { id: "gate", label: "入閘" },
  { id: "all", label: "全部" },
  { id: "breakout", label: "發動" },
  { id: "fake", label: "假突破" },
  { id: "coil", label: "量縮" },
  { id: "dual", label: "雙買" },
  { id: "watch", label: "關注" },
];

function kindTone(kind: StockRow["sopKind"]) {
  if (kind === "breakout") return "bg-gold/15 text-gold";
  if (kind === "fake") return "bg-up/15 text-up";
  if (kind === "weak") return "bg-down/15 text-down";
  return "bg-surface-2 text-muted";
}

function shortStatus(row: StockRow) {
  if (row.settlementPenalty) return "結算追價";
  if (row.sopKind === "breakout") return "強勢發動";
  if (row.sopKind === "fake") return "假突破";
  if (row.sopKind === "coil") return "量縮";
  if (row.sopKind === "watch") return "盤整";
  if (row.sopKind === "trend") return "趨勢";
  if (row.sopKind === "weak") return "弱勢";
  return "未入閘";
}

function downloadCsv(rows: StockRow[]) {
  const header = ["代號", "名稱", "產業", "現價", "漲跌幅", "糾結度", "量比", "外資張", "投信張", "SOP", "旗艦", "狀態", "籌碼"];
  const lines = rows.map((row) =>
    [
      row.code,
      row.name,
      row.sector,
      row.price,
      row.changePct,
      row.spreadPct,
      row.volRatio,
      row.foreign == null ? "" : Math.round(row.foreign / 1000),
      row.trust == null ? "" : Math.round(row.trust / 1000),
      row.sopScore ?? "",
      row.flagshipScore,
      row.sopLabel,
      row.chipLabel,
    ].join(","),
  );
  const blob = new Blob([`\uFEFF${header.join(",")}\n${lines.join("\n")}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "flagship50.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function Desk({ initial }: { initial: ScanResult }) {
  const scan = useServerFn(scanMarket);
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [lens, setLens] = useState<Lens>("gate");
  const [sector, setSector] = useState<string>("全部");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sop");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [view, setView] = useState<"list" | "heat">("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [watch, setWatch] = useState<string[]>([]);

  useEffect(() => {
    setData(initial);
  }, [initial]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]") as unknown;
      if (Array.isArray(parsed)) setWatch(parsed.filter((item) => typeof item === "string"));
    } catch {
      setWatch([]);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const narrow = window.matchMedia("(max-width: 767px)").matches;
    if (!narrow) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [selected]);

  const rows = data.ok ? data.rows : [];
  const watchSet = useMemo(() => new Set(watch), [watch]);

  const counts = useMemo(() => {
    return {
      gate: rows.filter((row) => row.inGate).length,
      breakout: rows.filter((row) => row.sopKind === "breakout").length,
      fake: rows.filter((row) => row.sopKind === "fake").length,
      dual: rows.filter((row) => row.chip === "dual-buy").length,
    };
  }, [rows]);

  const calls = useMemo(() => {
    const gated = rows.filter((row) => row.inGate).sort((a, b) => (b.sopScore ?? 0) - (a.sopScore ?? 0));
    if (gated.length > 0) return { title: "今日旗艦", hint: "原腳本會印出來的前段", items: gated.slice(0, 3) };
    const near = [...rows].sort((a, b) => a.spreadPct - b.spreadPct).slice(0, 3);
    return { title: "今日無入閘", hint: "最接近均線糾結的三檔", items: near };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let next = rows.filter((row) => {
      if (sector !== "全部" && row.sector !== sector) return false;
      if (q && !`${row.code} ${row.name} ${row.sector}`.toLowerCase().includes(q)) return false;
      if (lens === "gate") return row.inGate;
      if (lens === "breakout") return row.sopKind === "breakout";
      if (lens === "fake") return row.sopKind === "fake";
      if (lens === "coil") return row.sopKind === "coil" && row.inGate;
      if (lens === "dual") return row.chip === "dual-buy";
      if (lens === "watch") return watchSet.has(row.code);
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    next = [...next].sort((a, b) => {
      const value = (row: StockRow) => {
        if (sortKey === "flagship") return row.flagshipScore;
        if (sortKey === "sop") return row.sopScore;
        if (sortKey === "change") return row.changePct;
        if (sortKey === "spread") return row.spreadPct;
        if (sortKey === "vol") return row.volRatio;
        return row.foreign;
      };
      const av = value(a);
      const bv = value(b);
      if (av == null && bv == null) return a.code.localeCompare(b.code);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.code.localeCompare(b.code);
      return av > bv ? dir : -dir;
    });
    return next;
  }, [rows, sector, query, lens, watchSet, sortKey, sortDir]);

  const selectedRow = rows.find((row) => row.code === selected) ?? null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "spread" ? "asc" : "desc");
    }
  }

  function toggleWatch(code: string) {
    setWatch((current) => {
      const next = current.includes(code) ? current.filter((item) => item !== code) : [...current, code];
      localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const next = await scan({ data: { force: true } });
      setData(next);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-3 md:px-6">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-gold text-lg font-semibold text-ink">
            旗
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold leading-tight text-balance">旗艦五十</h1>
            <p className="truncate text-xs text-muted">台灣50觀察名單 · 波段糾結風控</p>
          </div>
          {data.ok && data.benchmark ? (
            <div className="hidden text-right sm:block">
              <p className="text-xs text-faint">0050 元大台灣50</p>
              <p className="num text-sm">
                {fmtPrice(data.benchmark.price)}{" "}
                <span className={toneClass(data.benchmark.changePct)}>{fmtPct(data.benchmark.changePct)}</span>
              </p>
            </div>
          ) : null}
          <button
            type="button"
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg bg-gold px-3 text-sm font-medium text-ink"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">{refreshing ? "掃描中" : "重新掃描"}</span>
          </button>
        </div>
      </header>

      {data.ok ? (
        <DeskBody
          data={data}
          counts={counts}
          calls={calls}
          visible={visible}
          lens={lens}
          sector={sector}
          query={query}
          view={view}
          sortKey={sortKey}
          watchSet={watchSet}
          onLens={(next) => {
            setLens(next);
            if (next === "gate" || next === "breakout" || next === "fake" || next === "coil") {
              setSortKey("sop");
              setSortDir("desc");
            } else {
              setSortKey("flagship");
              setSortDir("desc");
            }
          }}
          onSector={setSector}
          onQuery={setQuery}
          onView={setView}
          onSort={toggleSort}
          onSelect={setSelected}
          onToggleWatch={toggleWatch}
          onExport={() => downloadCsv(visible)}
          panelOpen={selected != null}
        />
      ) : (
        <main className="mx-auto max-w-xl px-4 py-16 text-center">
          <h2 className="text-xl font-semibold">這輪沒掃到</h2>
          <p className="mt-2 text-sm text-pretty text-muted">{data.error}</p>
          <button
            type="button"
            className="mt-6 inline-flex h-11 items-center rounded-lg bg-gold px-4 text-sm font-medium text-ink"
            onClick={() => void refresh()}
          >
            再試一次
          </button>
        </main>
      )}

      {selectedRow ? (
        <StockPanel
          row={selectedRow}
          watched={watchSet.has(selectedRow.code)}
          onClose={() => setSelected(null)}
          onToggleWatch={() => toggleWatch(selectedRow.code)}
        />
      ) : null}
    </div>
  );
}

function DeskBody({
  data,
  counts,
  calls,
  visible,
  lens,
  sector,
  query,
  view,
  sortKey,
  watchSet,
  onLens,
  onSector,
  onQuery,
  onView,
  onSort,
  onSelect,
  onToggleWatch,
  onExport,
  panelOpen,
}: {
  data: Extract<ScanResult, { ok: true }>;
  counts: { gate: number; breakout: number; fake: number; dual: number };
  calls: { title: string; hint: string; items: StockRow[] };
  visible: StockRow[];
  lens: Lens;
  sector: string;
  query: string;
  view: "list" | "heat";
  sortKey: SortKey;
  watchSet: Set<string>;
  onLens: (lens: Lens) => void;
  onSector: (sector: string) => void;
  onQuery: (query: string) => void;
  onView: (view: "list" | "heat") => void;
  onSort: (key: SortKey) => void;
  onSelect: (code: string) => void;
  onToggleWatch: (code: string) => void;
  onExport: () => void;
  panelOpen: boolean;
}) {
  const chipLag = data.chipDate != null && data.chipDate !== data.sessionDate;
  return (
    <main className={cn("mx-auto max-w-[1440px] px-4 py-4 md:px-6", panelOpen && "xl:pr-96")}>
      {data.settlement ? (
        <p className="mb-4 rounded-xl bg-surface px-4 py-3 text-sm text-pretty shadow-ring">
          <span className="font-medium text-gold">結算日風控。 </span>
          今天是週三，台指選擇權結算。權值股尾盤容易被造市商對沖，強勢發動已在兩套分數裡扣點。
        </p>
      ) : null}

      <p className="mb-4 text-xs text-faint">
        {data.weekdayLabel} · 行情 {data.sessionDate}
        {data.calendarDate !== data.sessionDate ? "（非當日盤）" : ""} · 籌碼 {data.chipDate ?? "未取得"} · 掃描{" "}
        {taipeiClock(data.scannedAt)} 台北
        {chipLag ? " · 籌碼日與行情日不同" : ""}
        {data.missing.length > 0 ? ` · ${data.missing.length} 檔報價缺失` : ""}
        <span className="ml-2 text-muted">紅漲綠跌</span>
      </p>

      {data.benchmark ? (
        <p className="num mb-4 text-sm sm:hidden">
          0050 {fmtPrice(data.benchmark.price)}{" "}
          <span className={toneClass(data.benchmark.changePct)}>{fmtPct(data.benchmark.changePct)}</span>
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="入閘糾結" value={String(counts.gate)} note={`共 ${data.rows.length} / ${data.universeSize} 檔`} />
        <Metric label="強勢發動" value={String(counts.breakout)} note="量價扎實突破" />
        <Metric label="假突破警戒" value={String(counts.fake)} note="爆量上影或收黑" />
        <Metric label="雙法人買超" value={String(counts.dual)} note="外資與投信同買" />
      </section>

      <section className="mt-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">{calls.title}</h2>
          <p className="text-xs text-faint">{calls.hint}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {calls.items.map((row, index) => (
            <button
              key={row.code}
              type="button"
              onClick={() => onSelect(row.code)}
              className="rounded-xl bg-surface p-4 text-left shadow-ring transition-shadow duration-200 hover:shadow-ring-strong"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-faint">{index === 0 ? "首選" : `第 ${index + 1}`}</p>
                  <p className="mt-1 font-medium">
                    {row.name} <span className="num text-faint">{row.code}</span>
                  </p>
                </div>
                <p className="text-right">
                  <span className="block text-xs text-faint">{row.inGate ? "SOP" : "旗艦"}</span>
                  <span className="num text-2xl text-gold">{row.inGate ? (row.sopScore ?? "—") : row.flagshipScore}</span>
                </p>
              </div>
              <p className="mt-3 flex items-baseline gap-2">
                <span className="num text-lg">{fmtPrice(row.price)}</span>
                <span className={cn("num text-sm", toneClass(row.changePct))}>{fmtPct(row.changePct)}</span>
              </p>
              <p className="mt-2 text-xs text-muted">
                糾結 {row.spreadPct.toFixed(2)}% · 量比 {row.volRatio.toFixed(2)} · {row.chipLabel}
              </p>
              <p className={cn("mt-3 inline-flex h-6 items-center rounded-md px-2 text-xs", kindTone(row.sopKind))}>
                {row.sopLabel}
              </p>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-5 flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <label className="sr-only" htmlFor="scan-search">
            搜尋代號或名稱
          </label>
          <input
            id="scan-search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜尋 2330、台積電、半導體"
            className="h-11 w-full rounded-lg bg-surface px-3 text-sm text-fg shadow-ring placeholder:text-faint md:max-w-xs"
          />
          <div className="flex flex-wrap gap-2">
            {LENSES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onLens(item.id)}
                className={cn(
                  "h-11 shrink-0 rounded-lg px-3 text-sm",
                  lens === item.id ? "bg-gold font-medium text-ink" : "bg-surface text-muted shadow-ring",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 md:ml-auto">
            <button
              type="button"
              onClick={() => onView(view === "list" ? "heat" : "list")}
              className="h-11 rounded-lg bg-surface px-3 text-sm text-fg shadow-ring"
            >
              {view === "list" ? "熱力圖" : "列表"}
            </button>
            <button
              type="button"
              onClick={onExport}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-surface px-3 text-sm text-fg shadow-ring"
            >
              <Download className="size-4" />
              CSV
            </button>
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {["全部", ...SECTORS].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onSector(item)}
              className={cn(
                "h-11 shrink-0 rounded-full px-3 text-xs",
                sector === item ? "bg-fg text-bg" : "bg-surface text-muted shadow-ring",
              )}
            >
              {item}
            </button>
          ))}
        </div>
        <p className="text-xs text-faint">顯示 {visible.length} 檔</p>
      </section>

      {visible.length === 0 ? (
        <div className="mt-6 rounded-xl bg-surface px-4 py-10 text-center shadow-ring">
          <ConvergeMark className="mx-auto h-8 w-16 text-gold" />
          <p className="mt-3 font-medium">這個條件底下沒有標的</p>
          <p className="mt-1 text-sm text-muted">換一個篩選，或改看全部 49 檔。</p>
        </div>
      ) : view === "heat" ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {visible.map((row) => (
            <button
              key={row.code}
              type="button"
              onClick={() => onSelect(row.code)}
              className={cn(
                "rounded-xl p-3 text-left shadow-ring",
                row.flagshipScore >= 75 ? "bg-gold/20" : row.flagshipScore >= 60 ? "bg-gold/10" : "bg-surface",
              )}
            >
              <p className="num text-xs text-faint">{row.code}</p>
              <p className="mt-1 truncate font-medium">{row.name}</p>
              <p className={cn("num mt-2 text-sm", toneClass(row.changePct))}>{fmtPct(row.changePct)}</p>
              <p className="num text-lg text-gold">{row.flagshipScore}</p>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="mt-2 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="w-10 py-2" />
                  <th className="py-2 font-medium">標的</th>
                  <th className="hidden py-2 font-medium xl:table-cell">產業</th>
                  <SortHead label="漲跌" active={sortKey === "change"} onClick={() => onSort("change")} />
                  <SortHead label="糾結" active={sortKey === "spread"} onClick={() => onSort("spread")} />
                  <SortHead label="量比" active={sortKey === "vol"} onClick={() => onSort("vol")} className="hidden lg:table-cell" />
                  <SortHead label="外資" active={sortKey === "foreign"} onClick={() => onSort("foreign")} className="hidden lg:table-cell" />
                  <th className="hidden py-2 font-medium lg:table-cell">投信</th>
                  <SortHead label="SOP" active={sortKey === "sop"} onClick={() => onSort("sop")} />
                  <SortHead label="旗艦" active={sortKey === "flagship"} onClick={() => onSort("flagship")} />
                  <th className="py-2 font-medium">狀態</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.code} className="border-b border-line hover:bg-surface">
                    <td className="py-2">
                      <button
                        type="button"
                        className="grid size-10 place-items-center"
                        aria-pressed={watchSet.has(row.code)}
                        aria-label={watchSet.has(row.code) ? `取消關注 ${row.name}` : `關注 ${row.name}`}
                        onClick={() => onToggleWatch(row.code)}
                      >
                        <Star className={watchSet.has(row.code) ? "size-4 fill-gold text-gold" : "size-4 text-faint"} />
                      </button>
                    </td>
                    <td className="py-2">
                      <button type="button" className="text-left" onClick={() => onSelect(row.code)}>
                        <span className="font-medium">{row.name}</span>
                        <span className="num ml-2 text-xs text-faint">{row.code}</span>
                      </button>
                    </td>
                    <td className="hidden py-2 text-muted xl:table-cell">{row.sector}</td>
                    <td className="py-2">
                      <button type="button" className="text-left" onClick={() => onSelect(row.code)}>
                        <span className="num">{fmtPrice(row.price)}</span>
                        <span className={cn("num ml-2 text-xs", toneClass(row.changePct))}>{fmtPct(row.changePct)}</span>
                      </button>
                    </td>
                    <td className="num py-2">{row.spreadPct.toFixed(2)}%</td>
                    <td className="num hidden py-2 lg:table-cell">{row.volRatio.toFixed(2)}</td>
                    <td className={cn("num hidden py-2 lg:table-cell", row.foreign == null ? "text-faint" : toneClass(row.foreign))}>
                      {row.foreign == null ? "—" : fmtLots(row.foreign)}
                    </td>
                    <td className={cn("num hidden py-2 lg:table-cell", row.trust == null ? "text-faint" : toneClass(row.trust))}>
                      {row.trust == null ? "—" : fmtLots(row.trust)}
                    </td>
                    <td className="num py-2">{row.sopScore ?? "—"}</td>
                    <td className="num py-2 text-gold">{row.flagshipScore}</td>
                    <td className="py-2">
                      <span className={cn("inline-flex h-6 items-center rounded-md px-2 text-xs", kindTone(row.sopKind))}>
                        {shortStatus(row)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-2 space-y-2 md:hidden">
            {visible.map((row) => (
              <li key={row.code}>
                <button
                  type="button"
                  onClick={() => onSelect(row.code)}
                  className="w-full rounded-xl bg-surface p-4 text-left shadow-ring"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {row.name} <span className="num text-xs text-faint">{row.code}</span>
                      </p>
                      <p className="mt-1 text-xs text-faint">{row.sector}</p>
                    </div>
                    <p className="num text-xl text-gold">{row.flagshipScore}</p>
                  </div>
                  <p className="mt-3 flex items-baseline gap-2">
                    <span className="num text-lg">{fmtPrice(row.price)}</span>
                    <span className={cn("num text-sm", toneClass(row.changePct))}>{fmtPct(row.changePct)}</span>
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    糾結 {row.spreadPct.toFixed(2)}% · 量比 {row.volRatio.toFixed(2)} · {row.chipLabel}
                    {row.sopScore != null ? ` · SOP ${row.sopScore}` : ""}
                  </p>
                  <span className={cn("mt-3 inline-flex h-6 items-center rounded-md px-2 text-xs", kindTone(row.sopKind))}>
                    {row.sopLabel}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Methodology scanned={data.rows.length} />
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-ring">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-1 text-3xl">{value}</p>
      <p className="mt-1 text-xs text-faint">{note}</p>
    </div>
  );
}

function SortHead({
  label,
  active,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn("py-2 font-medium", className)}>
          <button
            type="button"
            onClick={onClick}
            className={cn("inline-flex h-11 items-center", active && "text-gold")}
          >
        {label}
      </button>
    </th>
  );
}

function ConvergeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 32" className={className} aria-hidden>
      <path d="M2 4 C20 4 40 16 62 16" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 12 C22 12 42 16 62 16" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 20 C22 20 42 16 62 16" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 28 C20 28 40 16 62 16" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Methodology({ scanned }: { scanned: number }) {
  return (
    <section className="mt-10 border-t border-line pt-6">
      <details>
        <summary className="cursor-pointer text-sm font-medium">評分怎麼來的，以及跟原腳本差在哪</summary>
        <div className="mt-4 grid gap-6 text-sm text-muted md:grid-cols-2">
          <div>
            <h3 className="font-medium text-fg">原 SOP，數字沒有改</h3>
            <p className="mt-2 text-pretty">
              只在四條均線（5、10、20、60）高低價差小於收盤 5% 時給分，否則原腳本直接跳過。基礎 70。價差再小於 2.5% 加 10。量是 20 日均量 1.5 倍以上且收在月線上：實體乾淨加 20，上影超過整根 K 的 40% 或收黑扣 30。量比低於 0.8 加 5。外資與投信同買加 15，只有一邊買加 5，兩邊都賣扣 15。週三又是強勢發動再扣 10。這欄可以超過 100，跟舊腳本一樣不封頂。
            </p>
          </div>
          <div>
            <h3 className="font-medium text-fg">旗艦分數，讓沒入閘的也能排</h3>
            <p className="mt-2 text-pretty">
              0 到 100。從 40 起跳：極緊糾結 +18、普通入閘 +12、開始收斂 +5；多頭排列 +8；站上月線 ±5、站上季線 +5 / 跌破 −6；扎實突破 +16、假突破 −18、糾結量縮 +6；雙買 +12、單買 +5、分歧 +2、雙賣 −12；20 日相對 0050 超過 3 個百分點 ±6 / −4；結算日追價 −8。
            </p>
          </div>
          <div>
            <h3 className="font-medium text-fg">資料</h3>
            <p className="mt-2 text-pretty">
              日線來自 Yahoo Finance，近一年，這輪掃到 {scanned} 檔。三大法人用證交所 T86，外資是外陸資買賣超加上外資自營商，不是買進股數。本益比、殖利率、股價淨值比用證交所公開估值。觀察名單沿用原程式的 49 檔，不是每天重建的官方成分股。快取約 5 分鐘。原排程是台北時間 10:00、11:00、12:00、15:00 複核。
            </p>
          </div>
          <div>
            <h3 className="font-medium text-fg">不是投資建議</h3>
            <p className="mt-2 text-pretty">
              這是研究掃描台。分數、張數試算、停損假設都是規則的投影，不預測下一根 K，也不保證填得了價。
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}
