import { createFileRoute } from "@tanstack/react-router";
import { scanMarket } from "@/lib/scan";
import { Desk } from "@/components/desk";

export const Route = createFileRoute("/")({
  loader: () => scanMarket(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return <Desk initial={initial} />;
}
