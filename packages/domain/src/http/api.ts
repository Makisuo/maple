import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { ApiKeysApiGroup } from "./api-keys";
import { AlertsApiGroup } from "./alerts";
import { AuthApiGroup, AuthPublicApiGroup } from "./auth";
import { CloudflareLogpushApiGroup } from "./cloudflare-logpush";
import { DashboardsApiGroup } from "./dashboards";
import { IngestKeysApiGroup } from "./ingest-keys";
import { OrgTinybirdSettingsApiGroup } from "./org-tinybird-settings";
import { QueryEngineApiGroup } from "./query-engine";
import { ScrapeTargetsApiGroup } from "./scrape-targets";
import { ServiceDiscoveryApiGroup } from "./service-discovery";
import { TinybirdApiGroup } from "./tinybird";

export class MapleApi extends HttpApi.make("MapleApi")
  .add(AuthPublicApiGroup)
  .add(AuthApiGroup)
  .add(ApiKeysApiGroup)
  .add(AlertsApiGroup)
  .add(CloudflareLogpushApiGroup)
  .add(DashboardsApiGroup)
  .add(IngestKeysApiGroup)
  .add(OrgTinybirdSettingsApiGroup)
  .add(QueryEngineApiGroup)
  .add(ScrapeTargetsApiGroup)
  .add(ServiceDiscoveryApiGroup)
  .add(TinybirdApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Maple API",
      version: "1.0.0",
      description: "Effect-based backend API for Maple.",
    }),
  ) {}
