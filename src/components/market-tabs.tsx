import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";

const TABS = [
  { to: "/", label: "台股" },
  { to: "/us", label: "美股" },
] as const;

export function MarketTabs({ current }: { current: "/" | "/us" }) {
  return (
    <nav aria-label="市場" className="mx-auto flex max-w-[1440px] gap-2 px-4 pt-3 md:px-6">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={current === tab.to ? "page" : undefined}
          className={cn(
            "inline-flex h-11 items-center rounded-lg px-4 text-sm",
            current === tab.to ? "bg-gold font-medium text-ink" : "bg-surface text-muted shadow-ring",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
