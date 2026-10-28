import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { WireBar } from "@/lib/score";
import { fmtPrice } from "@/lib/format";

function axisDate(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}

export function PriceChart({ bars }: { bars: WireBar[] }) {
  const data = bars.map((bar) => ({
    t: bar[0],
    o: bar[1],
    h: bar[2],
    l: bar[3],
    c: bar[4],
    v: bar[5],
    ma20: bar[6],
    ma60: bar[7],
  }));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={axisDate}
            tick={{ fill: "var(--color-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            yAxisId="price"
            domain={["auto", "auto"]}
            tick={{ fill: "var(--color-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={52}
            tickFormatter={(value: number) => fmtPrice(value)}
          />
          <YAxis yAxisId="vol" orientation="right" hide domain={[0, (max: number) => max * 4]} />
          <Tooltip
            cursor={{ stroke: "var(--color-line)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as (typeof data)[number] | undefined;
              if (!row) return null;
              return (
                <div className="rounded-lg bg-surface px-3 py-2 text-xs shadow-ring">
                  <p className="text-muted">{axisDate(row.t)}</p>
                  <p className="num mt-1 text-fg">收 {fmtPrice(row.c)}</p>
                  <p className="num text-faint">
                    開 {fmtPrice(row.o)} · 高 {fmtPrice(row.h)} · 低 {fmtPrice(row.l)}
                  </p>
                </div>
              );
            }}
          />
          <Bar yAxisId="vol" dataKey="v" fill="var(--color-faint)" opacity={0.35} isAnimationActive={false} />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="ma60"
            stroke="var(--color-faint)"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="ma20"
            stroke="var(--color-gold)"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="c"
            stroke="var(--color-fg)"
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
