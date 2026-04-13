import { HttpRouter } from "effect/unstable/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Layer } from "effect";
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app";
import { DatabaseLibsqlLive } from "./services/DatabaseLibsqlLive";

const RuntimeLive = Layer.mergeAll(
  ApiObservabilityLive,
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
  Layer.provide(ApiAuthLive),
  Layer.provide(DatabaseLibsqlLive),
);

BunRuntime.runMain(app.pipe(Layer.launch as never));
