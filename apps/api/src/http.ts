import { MapleApi } from "@maple/domain/http";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApiKeysLive } from "./routes/api-keys.http";
import { HttpAlertsLive } from "./routes/alerts.http";
import { HttpAuthLive, HttpAuthPublicLive } from "./routes/auth.http";
import { HttpCloudflareLogpushLive } from "./routes/cloudflare-logpush.http";
import { HttpDashboardsLive } from "./routes/dashboards.http";
import { HttpDigestLive } from "./routes/digest.http";
import { HttpIngestKeysLive } from "./routes/ingest-keys.http";
import { HttpObservabilityLive } from "./routes/observability.http";
import { HttpOrgTinybirdSettingsLive } from "./routes/org-tinybird-settings.http";
import { HttpQueryEngineLive } from "./routes/query-engine.http";
import { HttpScrapeTargetsLive } from "./routes/scrape-targets.http";
import { HttpServiceDiscoveryLive } from "./routes/sd.http";
export const HttpApiRoutes = HttpApiBuilder.layer(MapleApi).pipe(
  Layer.provide(HttpAuthPublicLive),
  Layer.provide(HttpAuthLive),
  Layer.provide(HttpApiKeysLive),
  Layer.provide(HttpAlertsLive),
  Layer.provide(HttpCloudflareLogpushLive),
  Layer.provide(HttpDashboardsLive),
  Layer.provide(HttpDigestLive),
  Layer.provide(HttpIngestKeysLive),
  Layer.provide(HttpObservabilityLive),
  Layer.provide(HttpOrgTinybirdSettingsLive),
  Layer.provide(HttpScrapeTargetsLive),
  Layer.provide(HttpServiceDiscoveryLive),
  Layer.provide(HttpQueryEngineLive),
);
