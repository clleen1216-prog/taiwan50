import { createServerFn } from "@tanstack/react-start";
import { loadScan } from "@/lib/scan-core";

export type { ScanOk, ScanResult, StockRow } from "@/lib/scan-core";

export const scanMarket = createServerFn({ method: "GET" })
  .validator((input: { force?: boolean } | undefined) => ({
    force: Boolean(input?.force),
  }))
  .handler(async ({ data }) => loadScan(data.force));
