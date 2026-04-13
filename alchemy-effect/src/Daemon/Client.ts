import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { resolveSocketPath } from "./Config.ts";
import { DaemonConnectFailed, DaemonSocketNotReady } from "./Errors.ts";
import { DaemonRpcs } from "./RpcSchema.ts";

export type DaemonClient = Effect.Success<ReturnType<typeof makeClient>>;

export class Daemon extends Context.Service<Daemon, DaemonClient>()(
  "alchemy/Cli/Daemon",
) {}

export const makeClient = (socketPath: string) =>
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({ path: socketPath });
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerJson),
    );
    return yield* RpcClient.make(DaemonRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  });

const DAEMON_BIN = "process-manager.ts";
const HEARTBEAT_INTERVAL = "1 seconds" as const;

const resolveDaemonBin = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(path.dirname(import.meta.dirname), "bin", DAEMON_BIN);
});

/**
 * Layer that provides a connected `Daemon` client.
 *
 * On build:
 * 1. Try to connect to the existing daemon socket
 * 2. If that fails, spawn the daemon process and wait for the socket
 * 3. Connect to the socket
 * 4. Fork a heartbeat fiber that pings every second to keep the daemon alive
 * 5. When the scope closes, the heartbeat stops (daemon may idle-shutdown)
 */
export const DaemonLive: Layer.Layer<
  Daemon,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Layer.effect(
  Daemon,
  Effect.gen(function* () {
    const socketPath = yield* resolveSocketPath;

    const client = yield* tryConnect(socketPath).pipe(
      Effect.catchTag("DaemonConnectFailed", () =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Starting daemon…");
          yield* startDaemonProcess.pipe(Effect.forkChild);
          yield* waitForSocket(socketPath);
          yield* Effect.sleep("200 millis");
          return yield* tryConnect(socketPath);
        }),
      ),
      Effect.catchTag("PlatformError", (e) => Effect.die(e)),
      Effect.catchTag("DaemonConnectFailed", () =>
        Effect.die(new Error("Failed to connect to daemon")),
      ),
    );

    yield* client
      .heartbeat(void 0 as any)
      .pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)),
        Effect.forkScoped,
      );

    yield* Effect.logInfo("Connected to daemon");

    return client;
  }),
);

const waitForSocket = (socketPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.exists(socketPath).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.void : Effect.fail(new DaemonSocketNotReady()),
      ),
      Effect.retry(
        Schedule.spaced("100 millis").pipe(Schedule.both(Schedule.recurs(50))),
      ),
      Effect.catchTag("DaemonSocketNotReady", () =>
        Effect.fail(new DaemonConnectFailed()),
      ),
    );
  });

const tryConnect = (socketPath: string) =>
  makeClient(socketPath).pipe(
    Effect.catch(() => Effect.fail(new DaemonConnectFailed())),
  );

const startDaemonProcess = Effect.gen(function* () {
  const binPath = yield* resolveDaemonBin;
  const cmd = ChildProcess.make("bun", ["run", binPath]);
  yield* cmd;
});
