import { MapleApi } from "@maple/domain/http"
import { Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { McpLive } from "./mcp/app"
import { AutumnRouter } from "./routes/autumn.http"
import { HttpAlertsLive } from "./routes/alerts.http"
import { HttpApiKeysLive } from "./routes/api-keys.http"
import { HttpAuthLive, HttpAuthPublicLive } from "./routes/auth.http"
import { HttpCloudflareLogpushLive } from "./routes/cloudflare-logpush.http"
import { HttpDashboardsLive } from "./routes/dashboards.http"
import { HttpDigestLive } from "./routes/digest.http"
import { HttpIngestKeysLive } from "./routes/ingest-keys.http"
import { HttpObservabilityLive } from "./routes/observability.http"
import { HttpOrgTinybirdSettingsLive } from "./routes/org-tinybird-settings.http"
import { HttpQueryEngineLive } from "./routes/query-engine.http"
import { HttpScrapeTargetsLive } from "./routes/scrape-targets.http"
import { HttpServiceDiscoveryLive } from "./routes/sd.http"
import { AlertRuntime, AlertsService } from "./services/AlertsService"
import { ApiKeysService } from "./services/ApiKeysService"
import { AuthService } from "./services/AuthService"
import { AuthorizationLive } from "./services/AuthorizationLive"
import { CloudflareLogpushService } from "./services/CloudflareLogpushService"
import { DashboardPersistenceService } from "./services/DashboardPersistenceService"
import { DigestService } from "./services/DigestService"
import { EdgeCacheService } from "./services/EdgeCacheService"
import { EmailService } from "./services/EmailService"
import { Env } from "./services/Env"
import { OrgIngestKeysService } from "./services/OrgIngestKeysService"
import { OrgTinybirdSettingsService } from "./services/OrgTinybirdSettingsService"
import { QueryEngineService } from "./services/QueryEngineService"
import { ScrapeTargetsService } from "./services/ScrapeTargetsService"
import { TinybirdService } from "./services/TinybirdService"
import { TracerLive } from "./services/Telemetry"

export const HealthRouter = HttpRouter.use((router) =>
  router.add("GET", "/health", HttpServerResponse.text("OK")),
)

export const McpGetFallback = HttpRouter.use((router) =>
  router.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
)

export const DocsRoute = HttpApiScalar.layer(MapleApi, {
  path: "/docs",
})

export const InfraLive = Env.Default

export const CoreServicesLive = Layer.mergeAll(
  AuthService.layer,
  ApiKeysService.layer,
  CloudflareLogpushService.layer,
  DashboardPersistenceService.layer,
  OrgIngestKeysService.layer,
  OrgTinybirdSettingsService.layer,
  ScrapeTargetsService.layer,
).pipe(
  Layer.provideMerge(InfraLive),
)

export const TinybirdServiceLive = TinybirdService.layer.pipe(
  Layer.provideMerge(CoreServicesLive),
)

export const QueryEngineServiceLive = QueryEngineService.layer.pipe(
  Layer.provideMerge(TinybirdServiceLive),
  Layer.provideMerge(EdgeCacheService.layer),
)

export const AlertsServiceLive = AlertsService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CoreServicesLive,
      QueryEngineServiceLive,
      AlertRuntime.Default,
    ),
  ),
)

export const EmailServiceLive = EmailService.Default.pipe(
  Layer.provide(Env.Default),
)

export const DigestServiceLive = DigestService.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(InfraLive, TinybirdServiceLive, EmailServiceLive),
  ),
)

export const MainLive = Layer.mergeAll(
  CoreServicesLive,
  TinybirdServiceLive,
  QueryEngineServiceLive,
  AlertsServiceLive,
  DigestServiceLive,
)

export const ApiRoutes = HttpApiBuilder.layer(MapleApi).pipe(
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
)

export const AllRoutes = Layer.mergeAll(
  ApiRoutes,
  AutumnRouter,
  McpLive,
  HealthRouter,
  McpGetFallback,
  DocsRoute,
).pipe(
  Layer.provideMerge(
    HttpRouter.cors({
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["*"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  ),
)

export const ApiAuthLive = AuthorizationLive.pipe(
  Layer.provideMerge(Env.Default),
)

export const ApiObservabilityLive = Layer.mergeAll(
  TracerLive,
  Layer.succeed(
    HttpMiddleware.TracerDisabledWhen,
    (request: { url: string; method: string }) =>
      request.url === "/health" ||
      request.method === "OPTIONS" ||
      /\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(
        request.url,
      ),
  ),
)
