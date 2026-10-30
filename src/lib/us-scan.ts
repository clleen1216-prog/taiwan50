import { createServerFn } from "@tanstack/react-start";
import { loadScan } from "@/lib/us-scan-core";

export type { UsRow, UsScanOk, UsScanResult } from "@/lib/us-scan-core";

export const scanUs = createServerFn({ method: "GET" })
  .validator((input: { force?: boolean } | undefined) => ({ force: Boolean(input?.force) }))
  .handler(async ({ data }) => loadScan(data.force));
