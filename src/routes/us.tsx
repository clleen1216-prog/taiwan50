import { createFileRoute } from "@tanstack/react-router";
import { scanUs } from "@/lib/us-scan";
import { UsDesk } from "@/components/us-desk";

export const Route = createFileRoute("/us")({
  head: () => ({ meta: [{ title: "旗艦五十 · 美股" }] }),
  loader: () => scanUs(),
  component: UsHome,
});

function UsHome() {
  const initial = Route.useLoaderData();
  return <UsDesk initial={initial} />;
}
