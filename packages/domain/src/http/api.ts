import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { ApiKeysApiGroup } from "./api-keys";
import { AlertsApiGroup } from "./alerts";
import { AuthApiGroup, AuthPublicApiGroup } from "./auth";
import { CloudflareLogpushApiGroup } from "./cloudflare-logpush";
import { DashboardsApiGroup } from "./dashboards";
import { DigestApiGroup } from "./digest";
import { IngestKeysApiGroup } from "./ingest-keys";
import { ObservabilityApiGroup } from "./observability";
import { OrgTinybirdSettingsApiGroup } from "./org-tinybird-settings";
import { QueryEngineApiGroup } from "./query-engine";
import { ScrapeTargetsApiGroup } from "./scrape-targets";
import { ServiceDiscoveryApiGroup } from "./service-discovery";
export class MapleApi extends HttpApi.make("MapleApi")
  .add(AuthPublicApiGroup)
  .add(AuthApiGroup)
  .add(ApiKeysApiGroup)
  .add(AlertsApiGroup)
  .add(CloudflareLogpushApiGroup)
  .add(DashboardsApiGroup)
  .add(DigestApiGroup)
  .add(IngestKeysApiGroup)
  .add(ObservabilityApiGroup)
  .add(OrgTinybirdSettingsApiGroup)
  .add(QueryEngineApiGroup)
  .add(ScrapeTargetsApiGroup)
  .add(ServiceDiscoveryApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Maple API",
      version: "1.0.0",
      description: "Effect-based backend API for Maple.",
    }),
  ) {}
