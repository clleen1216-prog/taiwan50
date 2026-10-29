import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, RefreshCw, X } from "lucide-react";
import { scanUs, type UsRow, type UsScanResult } from "@/lib/us-scan";
import { fmtPct, fmtPrice, taipeiClock, toneClass } from "@/lib/format";
import { cn } from "@/lib/cn";
import { MarketTabs } from "@/components/market-tabs";
import { PriceChart } from "@/components/price-chart";

type Lens = "gate" | "all" | "breakout" | "fake" | "insider" | "earnings";

const LENSES: { id: Lens; label: string }[] = [
  { id: "gate", label: "入閘" },
  { id: "all", label: "全部" },
  { id: "breakout", label: "發動" },
  { id: "fake", label: "假突破" },
  { id: "insider", label: "內部人" },
  { id: "earnings", label: "財報週" },
];

function kindTone(row: UsRow) {
  if (row.earningsNear) return "bg-up/15 text-up";
  if (row.sopKind === "breakout") return "bg-gold/15 text-gold";
  if (row.sopKind === "fake") return "bg-up/15 text-up";
  if (row.sopKind === "weak") return "bg-down/15 text-down";
  return "bg-surface-2 text-muted";
}

function earningsText(row: UsRow) {
  if (row.earningsDays == null) return "財報日未知";
  if (row.earningsDays < 0) return "財報剛過";
  if (row.earningsDays === 0) return "今天財報";
  return `${row.earningsDays} 天後財報`;
}

export function UsDesk({ initial }: { initial: UsScanResult }) {
  const scan = useServerFn(scanUs);
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [lens, setLens] = useState<Lens>("gate");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => setData(initial), [initial]);

  const rows = data.ok ? data.rows : [];
  const counts = useMemo(
    () => ({
      gate: rows.filter((r) => r.inGate).length,
      breakout: rows.filter((r) => r.sopKind === "breakout").length,
      fake: rows.filter((r) => r.sopKind === "fake").length,
      insider: rows.filter((r) => r.insiderBought).length,
      earnings: rows.filter((r) => r.earningsNear).length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    const next = rows.filter((r) => {
      if (lens === "gate") return r.inGate;
      if (lens === "breakout") return r.sopKind === "breakout";
      if (lens === "fake") return r.sopKind === "fake";
      if (lens === "insider") return r.insiderBought;
      if (lens === "earnings") return r.earningsNear;
      return true;
    });
    return [...next].sort((a, b) =>
      lens === "gate" || lens === "breakout"
        ? (b.sopScore ?? -999) - (a.sopScore ?? -999)
        : b.flagshipScore - a.flagshipScore,
    );
  }, [rows, lens]);

  const selectedRow = rows.find((r) => r.symbol === selected) ?? null;

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

  async function refresh() {
    setRefreshing(true);
    try {
      setData(await scan({ data: { force: true } }));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-3 md:px-6">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-gold text-lg font-semibold text-ink">
            美
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold leading-tight text-balance">旗艦五十 · 美股</h1>
            <p className="truncate text-xs text-muted">科技與半導體 · 財報週防禦 · 內部人 Form 4</p>
          </div>
          {data.ok && data.benchmark ? (
            <div className="hidden text-right sm:block">
              <p className="text-xs text-faint">SPY</p>
              <p className="num text-sm">
                ${fmtPrice(data.benchmark.price)}{" "}
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
      <MarketTabs current="/us" />

      {data.ok ? (
        <main className={cn("mx-auto max-w-[1440px] px-4 py-4 md:px-6", selectedRow && "xl:pr-96")}>
          <p
            className={cn(
              "mb-4 rounded-xl bg-surface px-4 py-3 text-sm text-pretty shadow-ring",
              data.liquidity.status === "tightening" && "text-up",
            )}
          >
            <span className="font-medium text-gold">總經流動性。 </span>
            {data.liquidity.status === "unknown"
              ? "FRED 隔夜逆回購資料這輪沒取到。"
              : `${data.liquidity.label}：ON RRP 餘額 ${data.liquidity.value.toFixed(1)}B，近 5 個交易日${data.liquidity.changeAbs >= 0 ? "增加" : "減少"} ${Math.abs(data.liquidity.changeAbs).toFixed(1)}B。`}
            這是整體背景，不會幫個股加減分，因為對每檔一視同仁的扣分不影響排名。
          </p>

          {counts.earnings > 0 ? (
            <p className="mb-4 rounded-xl bg-surface px-4 py-3 text-sm text-pretty shadow-ring">
              <span className="font-medium text-up">財報週。 </span>
              {rows
                .filter((r) => r.earningsNear)
                .map((r) => `${r.symbol}（${earningsText(r)}）`)
                .join("、")}
              ：已扣分並暫停追價，防範 IV Crush。
            </p>
          ) : null}

          <p className="mb-4 text-xs text-faint">
            行情 {data.sessionDate}（美東） · 掃描 {taipeiClock(data.scannedAt)} 台北 · 財報日{" "}
            {data.earningsKnown}/{data.universeSize} 檔 · 內部人 {data.insiderKnown} 檔
            {data.missing.length > 0 ? ` · ${data.missing.length} 檔報價缺失` : ""}
            <span className="ml-2 text-muted">紅漲綠跌</span>
          </p>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="入閘糾結" value={counts.gate} note={`共 ${data.rows.length} / ${data.universeSize} 檔`} />
            <Metric label="強勢發動" value={counts.breakout} note="量價扎實突破" />
            <Metric label="假突破警戒" value={counts.fake} note="爆量上影或收黑" />
            <Metric label="內部人買進" value={counts.insider} note="近 30 天 ≥ $100K" />
          </section>

          <div className="mt-5 flex flex-wrap gap-2">
            {LENSES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLens(item.id)}
                className={cn(
                  "h-11 shrink-0 rounded-lg px-3 text-sm",
                  lens === item.id ? "bg-gold font-medium text-ink" : "bg-surface text-muted shadow-ring",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-faint">顯示 {visible.length} 檔</p>

          {visible.length === 0 ? (
            <div className="mt-4 rounded-xl bg-surface px-4 py-10 text-center shadow-ring">
              <p className="font-medium">這個條件底下沒有標的</p>
              <p className="mt-1 text-sm text-muted">換一個篩選，或改看全部。</p>
            </div>
          ) : (
            <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((row) => (
                <li key={row.symbol}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.symbol)}
                    className="w-full rounded-xl bg-surface p-4 text-left shadow-ring transition-shadow duration-200 hover:shadow-ring-strong"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {row.name} <span className="num text-xs text-faint">{row.symbol}</span>
                        </p>
                        <p className="mt-1 text-xs text-faint">{row.sector}</p>
                      </div>
                      <p className="text-right">
                        <span className="block text-xs text-faint">{row.inGate ? "SOP" : "旗艦"}</span>
                        <span className="num text-2xl text-gold">
                          {row.inGate ? (row.sopScore ?? "—") : row.flagshipScore}
                        </span>
                      </p>
                    </div>
                    <p className="mt-3 flex items-baseline gap-2">
                      <span className="num text-lg">${fmtPrice(row.price)}</span>
                      <span className={cn("num text-sm", toneClass(row.changePct))}>{fmtPct(row.changePct)}</span>
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      糾結 {row.spreadPct.toFixed(2)}% · 量比 {row.volRatio.toFixed(2)} · {earningsText(row)}
                      {row.insiderBought ? " · 內部人買進" : ""}
                    </p>
                    <span className={cn("mt-3 inline-flex h-6 items-center rounded-md px-2 text-xs", kindTone(row))}>
                      {row.sopLabel}
                    </span>
                    {row.insiderBonus ? (
                      <span className="ml-2 inline-flex h-6 items-center rounded-md bg-gold/15 px-2 text-xs text-gold">
                        內部人 +20
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section className="mt-10 border-t border-line pt-6">
            <details>
              <summary className="cursor-pointer text-sm font-medium">評分與資料說明</summary>
              <div className="mt-4 grid gap-6 text-sm text-muted md:grid-cols-2">
                <div>
                  <h3 className="font-medium text-fg">評分</h3>
                  <p className="mt-2 text-pretty">
                    跟台股共用同一套核心：四條均線價差小於 5% 才入閘，基礎 70，小於 2.5% 加 10，爆量扎實突破加 20、假突破扣 30、量縮加 5。財報週（0 到 3 天內）SOP 扣 40、旗艦扣 30。糾結突破又有內部人公開市場買進，兩套分數各加 20。
                  </p>
                </div>
                <div>
                  <h3 className="font-medium text-fg">資料與限制</h3>
                  <p className="mt-2 text-pretty">
                    日線來自 Yahoo Finance。財報日來自 Yahoo quoteSummary，抓不到會明確標示「財報日未知」，不會當成安全。內部人用 SEC EDGAR 的 Form 4，只算交易代碼 P（公開市場買進）、官員或董事、近 30 天合計 ≥ $100K；賣出、股票授予、選擇權行權不算。ASML、TSM 是外國發行人，不申報 Form 4。流動性用 FRED 隔夜逆回購餘額的絕對變動。財報日與內部人快取 6 小時。
                  </p>
                </div>
                <div>
                  <h3 className="font-medium text-fg">不是投資建議</h3>
                  <p className="mt-2 text-pretty">
                    這是研究掃描台。內部人買進只代表個人在公開市場出資，不保證股價上漲。
                  </p>
                </div>
              </div>
            </details>
          </section>
        </main>
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

      {selectedRow ? <UsPanel row={selectedRow} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-ring">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-1 text-3xl">{value}</p>
      <p className="mt-1 text-xs text-faint">{note}</p>
    </div>
  );
}

function UsPanel({ row, onClose }: { row: UsRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 bg-ink/70 md:hidden"
        aria-label="關閉個股"
        onClick={onClose}
      />
      <aside className="fixed inset-0 z-40 overflow-y-auto bg-raised md:inset-y-0 md:left-auto md:right-0 md:w-96 md:border-l md:border-line">
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-line bg-raised px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-faint">
              {row.symbol} · {row.sector}
            </p>
            <h2 className="text-xl font-semibold text-balance">{row.name}</h2>
            <p className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="num text-2xl">${fmtPrice(row.price)}</span>
              <span className={cn("num text-sm", toneClass(row.changePct))}>{fmtPct(row.changePct)}</span>
            </p>
          </div>
          <button
            type="button"
            className="grid size-11 place-items-center rounded-lg bg-surface text-fg shadow-ring"
            aria-label="關閉"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-6 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex h-7 items-center rounded-md px-2 text-xs font-medium", kindTone(row))}>
              {row.sopLabel}
            </span>
            <span className="num rounded-md bg-surface px-2 py-1 text-xs text-gold">旗艦 {row.flagshipScore}</span>
            <span className="num rounded-md bg-surface px-2 py-1 text-xs text-muted">SOP {row.sopScore ?? "—"}</span>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-faint">
              <span>收盤</span>
              <span className="flex gap-3">
                <span className="text-gold">月線</span>
                <span>季線</span>
              </span>
            </div>
            <PriceChart bars={row.bars} />
          </div>

          <section>
            <h3 className="text-sm font-medium">為什麼是這個分數</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-muted">
              {row.notes.map((note) => (
                <li key={note} className="border-l-2 border-gold/60 pl-3 text-pretty">
                  {note}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-medium">SOP 檢查</h3>
            <ul className="mt-2 divide-y divide-line">
              {row.checks.map((check) => (
                <li key={check.label} className="flex items-center gap-3 py-2 text-sm">
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full",
                      check.pass ? "bg-gold/20 text-gold" : "bg-surface-2 text-faint",
                    )}
                    aria-hidden
                  >
                    {check.pass ? <Check className="size-3" /> : <span className="text-xs">–</span>}
                  </span>
                  <span className="flex-1">{check.label}</span>
                  <span className="num text-xs text-faint">{check.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-medium">內部人與財報</h3>
            <p className="mt-2 text-sm text-pretty text-muted">{row.insiderNote}</p>
            <p className="mt-1 text-sm text-pretty text-muted">{earningsText(row)}</p>
          </section>

          <section>
            <h3 className="text-sm font-medium">均線</h3>
            <dl className="mt-2 grid grid-cols-4 gap-2">
              {[
                ["MA5", row.ma5],
                ["MA10", row.ma10],
                ["MA20", row.ma20],
                ["MA60", row.ma60],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-surface px-2 py-2 text-center shadow-ring">
                  <dt className="text-xs text-faint">{label}</dt>
                  <dd className="num mt-1 text-sm">{fmtPrice(Number(value))}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </aside>
    </>
  );
}
