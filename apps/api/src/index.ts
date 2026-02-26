import { HttpApiScalar, HttpLayerRouter, HttpMiddleware, HttpServerResponse } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { MapleApi } from "@maple/domain/http"
import { Config, Layer } from "effect"
import { HttpApiRoutes } from "./http"
import { McpLive } from "./mcp/app"
import { AutumnRouter } from "./routes/autumn.http"
import { ApiKeysService } from "./services/ApiKeysService"
import { AuthorizationLive } from "./services/AuthorizationLive"
import { DashboardPersistenceService } from "./services/DashboardPersistenceService"
import { Env } from "./services/Env"
import { OrgIngestKeysService } from "./services/OrgIngestKeysService"
import { QueryEngineService } from "./services/QueryEngineService"
import { ScrapeTargetsService } from "./services/ScrapeTargetsService"
import { TinybirdService } from "./services/TinybirdService"
import { AuthService } from "./services/AuthService"
import { TracerLive } from "./services/Telemetry"

const HealthRouter = HttpLayerRouter.use((router) =>
  router.add("GET", "/health", HttpServerResponse.text("OK")),
)

// Return 405 for GET /mcp so MCP Streamable HTTP clients skip SSE gracefully
const McpGetFallback = HttpLayerRouter.use((router) =>
  router.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
)

const DocsRoute = HttpApiScalar.layerHttpLayerRouter({
  api: MapleApi,
  path: "/docs",
})

const AllRoutes = Layer.mergeAll(HttpApiRoutes, HealthRouter, McpGetFallback, DocsRoute, AutumnRouter, McpLive).pipe(
  Layer.provideMerge(
    HttpLayerRouter.cors({
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["*"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  ),
)

const MainLive = Layer.mergeAll(
  Env.Default,
  TinybirdService.Default,
  QueryEngineService.Default,
  AuthService.Default,
  ApiKeysService.Live,
  DashboardPersistenceService.Live,
  OrgIngestKeysService.Live,
  ScrapeTargetsService.Live,
)

const app = HttpLayerRouter.serve(AllRoutes).pipe(
  HttpMiddleware.withTracerDisabledWhen(
    (request) => request.url === "/health" || request.method === "OPTIONS",
  ),
  Layer.provideMerge(MainLive),
  Layer.provide(TracerLive),
  Layer.provide(
    AuthorizationLive.pipe(Layer.provideMerge(Env.Default)),
  ),
  Layer.provideMerge(
    BunHttpServer.layerConfig(
      Config.all({
        port: Config.number("PORT").pipe(Config.withDefault(3472)),
        idleTimeout: Config.succeed(120),
      }),
    ).pipe(Layer.orDie),
  ),
)

BunRuntime.runMain(Layer.launch(app))
