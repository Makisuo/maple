import { HttpApiScalar } from "effect/unstable/httpapi";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { MapleApi } from "@maple/domain/http";
import { Config, Layer } from "effect";
import { HttpApiRoutes } from "./http";
import { McpLive } from "./mcp/app";
import { AutumnRouter } from "./routes/autumn.http";
import { ChatRouter } from "./chat/route";
import { ChatService } from "./chat/chat-service";
import { ApiKeysService } from "./services/ApiKeysService";
import { AuthorizationLive } from "./services/AuthorizationLive";
import { CloudflareLogpushService } from "./services/CloudflareLogpushService";
import { DashboardPersistenceService } from "./services/DashboardPersistenceService";
import { Env } from "./services/Env";
import { OrgIngestKeysService } from "./services/OrgIngestKeysService";
import { OrgTinybirdSettingsService } from "./services/OrgTinybirdSettingsService";
import { QueryBuilderService } from "./services/QueryBuilderService";
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

const AllRoutes = Layer.mergeAll(
  HttpApiRoutes,
  HealthRouter,
  McpGetFallback,
  DocsRoute,
  AutumnRouter,
  McpLive,
  ChatRouter,
).pipe(
  Layer.provide(
    HttpRouter.cors({
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["*"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  ),
);

const MainLive = Layer.mergeAll(
  Env.layer,
  TinybirdService.layer,
  QueryBuilderService.layer,
  QueryEngineService.layer,
  AuthService.layer,
  ChatService.layer,
  ApiKeysService.layer,
  CloudflareLogpushService.layer,
  DashboardPersistenceService.layer,
  OrgIngestKeysService.layer,
  OrgTinybirdSettingsService.layer,
  ScrapeTargetsService.layer,
);

const app = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(
    Layer.succeed(
      HttpMiddleware.TracerDisabledWhen,
      (request: { url: string; method: string }) =>
        request.url === "/health" || request.method === "OPTIONS",
    ),
  ),
  Layer.provide(MainLive),
  Layer.provide(TracerLive),
  Layer.provide(AuthorizationLive),
  Layer.provide(
    BunHttpServer.layerConfig(
      Config.all({
        port: Config.number("PORT").pipe(Config.withDefault(3472)),
        idleTimeout: Config.succeed(120),
      }),
    ).pipe(Layer.orDie),
  ),
);

BunRuntime.runMain(app.pipe(Layer.launch as never));
