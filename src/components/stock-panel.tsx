import { useEffect, useState } from "react";
import { Check, Star, X } from "lucide-react";
import type { StockRow } from "@/lib/scan";
import { fmtLots, fmtPct, fmtPrice, toneClass } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PriceChart } from "@/components/price-chart";

const CAPITAL_KEY = "flagship50.capital";

function kindTone(kind: StockRow["sopKind"]) {
  if (kind === "breakout") return "bg-gold/15 text-gold";
  if (kind === "fake") return "bg-up/15 text-up";
  if (kind === "weak") return "bg-down/15 text-down";
  return "bg-surface-2 text-muted";
}

export function StockPanel({
  row,
  watched,
  onClose,
  onToggleWatch,
}: {
  row: StockRow;
  watched: boolean;
  onClose: () => void;
  onToggleWatch: () => void;
}) {
  const [capital, setCapital] = useState(1_000_000);
  const [riskPct, setRiskPct] = useState(1);

  useEffect(() => {
    const raw = localStorage.getItem(CAPITAL_KEY);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) setCapital(parsed);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stop = row.price > row.ma20 ? row.ma20 : row.low;
  const riskPerShare = row.price - stop;
  const budget = capital * (riskPct / 100);
  const shares = riskPerShare > 0 ? Math.floor(budget / riskPerShare) : 0;
  const lots = Math.floor(shares / 1000);

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
              {row.code} · {row.sector}
            </p>
            <h2 className="text-xl font-semibold text-balance">{row.name}</h2>
            <p className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="num text-2xl">{fmtPrice(row.price)}</span>
              <span className={cn("num text-sm", toneClass(row.changePct))}>
                {fmtPct(row.changePct)}
              </span>
            </p>
          </div>
          <button
            type="button"
            className="grid size-11 place-items-center rounded-lg bg-surface text-fg shadow-ring"
            aria-pressed={watched}
            aria-label={watched ? "移出關注" : "加入關注"}
            onClick={onToggleWatch}
          >
            <Star className={watched ? "size-5 fill-gold text-gold" : "size-5 text-faint"} />
          </button>
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
            <span className={cn("inline-flex h-7 items-center rounded-md px-2 text-xs font-medium", kindTone(row.sopKind))}>
              {row.sopLabel}
            </span>
            <span className="num rounded-md bg-surface px-2 py-1 text-xs text-gold">
              旗艦 {row.flagshipScore}
            </span>
            <span className="num rounded-md bg-surface px-2 py-1 text-xs text-muted">
              SOP {row.sopScore ?? "—"}
            </span>
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

          <dl className="grid grid-cols-4 gap-2 text-center">
            {[
              ["開", fmtPrice(row.open)],
              ["高", fmtPrice(row.high)],
              ["低", fmtPrice(row.low)],
              ["量", fmtLots(row.volume).replace("+", "")],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-surface px-2 py-2 shadow-ring">
                <dt className="text-xs text-faint">{label}</dt>
                <dd className="num mt-1 text-sm">{value}</dd>
              </div>
            ))}
          </dl>

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
            <h3 className="text-sm font-medium">籌碼與估值</h3>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <Stat label="外資" value={row.foreign == null ? "—" : fmtLots(row.foreign)} tone={row.foreign} />
              <Stat label="投信" value={row.trust == null ? "—" : fmtLots(row.trust)} tone={row.trust} />
              <Stat label="自營商" value={row.dealer == null ? "—" : fmtLots(row.dealer)} tone={row.dealer} />
              <Stat label="三大法人" value={row.totalInst == null ? "—" : fmtLots(row.totalInst)} tone={row.totalInst} />
              <Stat label="本益比" value={row.pe == null ? "—" : row.pe.toFixed(2)} />
              <Stat label="股價淨值比" value={row.pb == null ? "—" : row.pb.toFixed(2)} />
              <Stat label="殖利率" value={row.dividendYield == null ? "—" : `${row.dividendYield.toFixed(2)}%`} />
              <Stat label="相對 0050" value={row.rs20 == null ? "—" : fmtPct(row.rs20)} tone={row.rs20} />
            </dl>
            <p className="mt-2 text-xs text-pretty text-faint">
              外資含外陸資與外資自營商買賣超，單位換成張。原腳本把買進股數誤當成買賣超，這裡已改回證交所欄位。
            </p>
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

          <section className="rounded-xl bg-surface p-4 shadow-ring">
            <h3 className="text-sm font-medium">風控試算</h3>
            <p className="mt-1 text-xs text-pretty text-faint">
              停損預設放在{row.price > row.ma20 ? "月線" : "當日低點"} {fmtPrice(stop)}。這是部位尺寸，不是買賣建議。
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                帳戶資金
                <input
                  inputMode="numeric"
                  className="num mt-1 h-11 w-full rounded-lg bg-bg px-3 text-sm text-fg shadow-ring"
                  value={capital}
                  onChange={(event) => {
                    const next = Number(event.target.value.replace(/,/g, ""));
                    if (!Number.isFinite(next)) return;
                    setCapital(next);
                    localStorage.setItem(CAPITAL_KEY, String(next));
                  }}
                />
              </label>
              <label className="text-xs text-muted">
                單筆風險 %
                <input
                  inputMode="decimal"
                  className="num mt-1 h-11 w-full rounded-lg bg-bg px-3 text-sm text-fg shadow-ring"
                  value={riskPct}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    setRiskPct(Math.min(20, Math.max(0, next)));
                  }}
                />
              </label>
            </div>
            <p className="num mt-3 text-lg">
              {riskPerShare <= 0
                ? "停損價不合理"
                : lots > 0
                  ? `${lots.toLocaleString("zh-TW")} 張`
                  : `不足一張（約 ${shares.toLocaleString("zh-TW")} 股）`}
            </p>
            <p className="text-xs text-faint">
              風險預算 {Math.round(budget).toLocaleString("zh-TW")} 元
              {riskPerShare > 0 ? ` · 每張約 ${Math.round(riskPerShare * 1000).toLocaleString("zh-TW")} 元` : ""}
            </p>
          </section>
        </div>
      </aside>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2 shadow-ring">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className={cn("num mt-1", tone == null ? "text-fg" : toneClass(tone))}>{value}</dd>
    </div>
  );
}
