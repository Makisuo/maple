import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";

import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { CloudflareLogpushSection } from "@/components/settings/cloudflare-logpush-section";
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs";
import { FireIcon, ShieldIcon } from "@/components/icons";

const ConnectorsSearch = Schema.Struct({
  tab: Schema.optionalWith(
    Schema.Literal("cloudflare", "prometheus"),
    { default: () => "cloudflare" as const },
  ),
});

export const Route = createFileRoute("/connectors")({
  component: ConnectorsPage,
  validateSearch: Schema.standardSchemaV1(ConnectorsSearch),
});

function ConnectorsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Connectors" }]}
      title="Connectors"
      description="Connect external data sources to ingest metrics alongside your OpenTelemetry data."
    >
      <Tabs
        value={search.tab}
        onValueChange={(tab) =>
          navigate({
            search: { tab: tab as "cloudflare" | "prometheus" },
          })
        }
      >
        <TabsList variant="line">
          <TabsTrigger value="cloudflare">
            <ShieldIcon size={14} />
            Cloudflare Logpush
          </TabsTrigger>
          <TabsTrigger value="prometheus">
            <FireIcon size={14} />
            Prometheus
          </TabsTrigger>
        </TabsList>
        <TabsContent value="cloudflare" className="pt-4" keepMounted>
          <CloudflareLogpushSection />
        </TabsContent>
        <TabsContent value="prometheus" className="pt-4" keepMounted>
          <ScrapeTargetsSection />
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}
