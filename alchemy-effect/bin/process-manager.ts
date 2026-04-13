import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { BunSQLite, main, NodeServices } from "../src/Daemon/RpcServer.ts";

main.pipe(
  Effect.provide(NodeServices.layer),
  Effect.provide(BunSQLite),
  Effect.catchTag("DaemonAlreadyRunning", (err) => Effect.logInfo(err.message)),
  NodeRuntime.runMain,
);
