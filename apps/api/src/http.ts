import { HttpLayerRouter } from "@effect/platform";
import { MapleApi } from "@maple/domain/http";
import { Layer } from "effect";
import { HttpApiKeysLive } from "./routes/api-keys.http";
import { HttpAuthLive, HttpAuthPublicLive } from "./routes/auth.http";
import { HttpCloudflareLogpushLive } from "./routes/cloudflare-logpush.http";
import { HttpDashboardsLive } from "./routes/dashboards.http";
import { HttpIngestKeysLive } from "./routes/ingest-keys.http";
import { HttpOrgTinybirdSettingsLive } from "./routes/org-tinybird-settings.http";
import { HttpQueryEngineLive } from "./routes/query-engine.http";
import { HttpScrapeTargetsLive } from "./routes/scrape-targets.http";
import { HttpServiceDiscoveryLive } from "./routes/sd.http";
import { HttpTinybirdLive } from "./routes/tinybird.http";

export const HttpApiRoutes = HttpLayerRouter.addHttpApi(MapleApi).pipe(
  Layer.provideMerge(HttpAuthPublicLive),
  Layer.provideMerge(HttpAuthLive),
  Layer.provideMerge(HttpApiKeysLive),
  Layer.provideMerge(HttpCloudflareLogpushLive),
  Layer.provideMerge(HttpDashboardsLive),
  Layer.provideMerge(HttpIngestKeysLive),
  Layer.provideMerge(HttpOrgTinybirdSettingsLive),
  Layer.provideMerge(HttpScrapeTargetsLive),
  Layer.provideMerge(HttpServiceDiscoveryLive),
  Layer.provideMerge(HttpTinybirdLive),
  Layer.provideMerge(HttpQueryEngineLive),
);
