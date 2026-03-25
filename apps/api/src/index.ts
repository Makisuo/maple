import { HttpApiScalar } from "effect/unstable/httpapi";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { MapleApi } from "@maple/domain/http";
import { Config, Layer } from "effect";
import { HttpApiRoutes } from "./http";
import { McpLive } from "./mcp/app";
import { AutumnRouter } from "./routes/autumn.http";
import { ApiKeysService } from "./services/ApiKeysService";
import { AlertRuntime, AlertsService } from "./services/AlertsService";
import { AuthorizationLive } from "./services/AuthorizationLive";
import { CloudflareLogpushService } from "./services/CloudflareLogpushService";
import { DashboardPersistenceService } from "./services/DashboardPersistenceService";
import { Database } from "./services/DatabaseLive";
import { Env } from "./services/Env";
import { OrgIngestKeysService } from "./services/OrgIngestKeysService";
import { OrgTinybirdSettingsService } from "./services/OrgTinybirdSettingsService";
import { QueryEngineService } from "./services/QueryEngineService";
import { ScrapeTargetsService } from "./services/ScrapeTargetsService";
import { TinybirdService } from "./services/TinybirdService";
import { AuthService } from "./services/AuthService";
import { TracerLive } from "./services/Telemetry";

const HealthRouter = HttpRouter.use((router) =>
  router.add("GET", "/health", HttpServerResponse.text("OK")),
);

// Return 405 for GET /mcp so MCP Streamable HTTP clients skip SSE gracefully
const McpGetFallback = HttpRouter.use((router) =>
  router.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
);

const DocsRoute = HttpApiScalar.layer(MapleApi, {
  path: "/docs",
});

const InfraLive = Database.layer.pipe(
  Layer.provideMerge(Env.layer),
)

const CoreServicesLive = Layer.mergeAll(
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

const TinybirdServiceLive = TinybirdService.layer.pipe(
  Layer.provideMerge(CoreServicesLive),
)

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
  Layer.provideMerge(TinybirdServiceLive),
)

const AlertsServiceLive = AlertsService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(CoreServicesLive, QueryEngineServiceLive, AlertRuntime.Default)),
)

const MainLive = Layer.mergeAll(
  CoreServicesLive,
  TinybirdServiceLive,
  QueryEngineServiceLive,
  AlertsServiceLive,
)

const AllRoutes = Layer.mergeAll(
  HttpApiRoutes,
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
);

const RuntimeLive = Layer.mergeAll(
  TracerLive,
  Layer.succeed(
    HttpMiddleware.TracerDisabledWhen,
    (request: { url: string; method: string }) =>
      request.url === "/health" || request.method === "OPTIONS",
  ),
  BunHttpServer.layerConfig(
    Config.all({
      port: Config.number("PORT").pipe(Config.withDefault(3472)),
      idleTimeout: Config.succeed(120),
    }),
  ).pipe(Layer.orDie),
)

const app = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(RuntimeLive),
  Layer.provide(MainLive),
  Layer.provide(AuthorizationLive.pipe(Layer.provideMerge(Env.layer))),
);

BunRuntime.runMain(app.pipe(Layer.launch as never));
