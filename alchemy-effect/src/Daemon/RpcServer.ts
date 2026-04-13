import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { type SQLiteConnection } from "../SQLite/index.ts";
import { SQLite } from "../SQLite/SQLite.ts";
import {
  ALCHEMY_DIR,
  DB_FILE,
  ensureAlchemyDir,
  PROCESSES_DIR,
  resolveSocketPath,
  SOCKET_FILE,
} from "./Config.ts";
import { ProcessAlreadyExists, ProcessNotFound } from "./Errors.ts";
import { acquireLock, isProcessAlive } from "./Lock.ts";
import { makeProcessRegistry } from "./ProcessRegistry.ts";
import { DaemonRpcs } from "./RpcSchema.ts";

// Re-export platform layers needed by the entry point
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BunSQLite } from "../SQLite/index.ts";

export { BunSQLite, NodeServices };

const IDLE_TIMEOUT = Duration.seconds(10);

export const main = Effect.gen(function* () {
  const shutdownSignal = yield* Deferred.make<void>();

  yield* Effect.logInfo("Acquiring daemon lock…");
  yield* acquireLock(shutdownSignal);

  const db = yield* initDb;
  yield* cleanupOrphans(db);

  yield* cleanStaleSocket;

  const socketPath = yield* resolveSocketPath;
  yield* Effect.logInfo("Starting daemon socket server…");

  const socketServerLayer = NodeSocketServer.layer({ path: socketPath });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(socketPath, { force: true }).pipe(Effect.ignore);
    }),
  );

  const watchdog = yield* makeIdleWatchdog(shutdownSignal);
  yield* watchdog.startWatchdog;
  yield* watchdog.recordHeartbeat;

  const procRegistry = yield* makeProcessRegistry(db);

  const rpcServerLayer = RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(socketServerLayer),
    Layer.provide(makeHandlersLayer(watchdog, procRegistry)),
    Layer.provide(NodeServices.layer),
    Layer.provide(BunSQLite),
  );

  yield* Layer.launch(rpcServerLayer).pipe(Effect.forkScoped);

  yield* Effect.logInfo("Daemon ready");

  yield* watchdog.awaitShutdown;
}).pipe(Effect.scoped);

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------

const cleanStaleSocket = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(ALCHEMY_DIR);
  const socketPath = path.join(dir, SOCKET_FILE);
  yield* fs.remove(socketPath, { force: true });
});

// ---------------------------------------------------------------------------
// SQLite — process metadata persistence
// ---------------------------------------------------------------------------

const initDb = Effect.gen(function* () {
  const sqlite = yield* SQLite;
  const path = yield* Path.Path;
  const dir = yield* ensureAlchemyDir;
  const dbPath = path.join(dir, DB_FILE);
  const db = yield* sqlite.open(dbPath);

  yield* db.exec(`
    CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      cwd TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
});

interface ProcessRow {
  id: string;
  pid: number;
  command: string;
  args: string;
  cwd: string | null;
}

// ---------------------------------------------------------------------------
// Boot cleanup — kill orphans from a previous crashed daemon
// ---------------------------------------------------------------------------

const cleanupOrphans = (db: SQLiteConnection) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* ensureAlchemyDir;
    const processesDir = path.join(dir, PROCESSES_DIR);

    const stmt = yield* db.prepare<ProcessRow>("SELECT id, pid FROM processes");
    const orphans = yield* stmt.all();

    if (orphans.length === 0) return;

    yield* Effect.logInfo(`Cleaning up ${orphans.length} orphan process(es)…`);

    for (const orphan of orphans) {
      yield* isProcessAlive(orphan.pid).pipe(
        Effect.flatMap((alive) =>
          alive
            ? Effect.sync(() => {
                try {
                  process.kill(orphan.pid, "SIGKILL");
                } catch {}
              })
            : Effect.void,
        ),
      );

      yield* fs
        .remove(path.join(processesDir, orphan.id), {
          recursive: true,
          force: true,
        })
        .pipe(Effect.ignore);
    }

    const delStmt = yield* db.prepare("DELETE FROM processes");
    yield* delStmt.run();

    yield* Effect.logInfo(`Cleaned up ${orphans.length} orphan(s)`);
  });

// ---------------------------------------------------------------------------
// Idle shutdown — heartbeat-based
// ---------------------------------------------------------------------------

const makeIdleWatchdog = (shutdownSignal: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const lastHeartbeat = yield* Ref.make(Date.now());

    const recordHeartbeat = Ref.set(lastHeartbeat, Date.now());

    const startWatchdog = Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* Effect.sleep(IDLE_TIMEOUT);
        const last = yield* Ref.get(lastHeartbeat);
        const elapsed = Date.now() - last;
        if (elapsed >= Duration.toMillis(IDLE_TIMEOUT)) {
          yield* Effect.logInfo("No heartbeat received — shutting down daemon");
          yield* Deferred.succeed(shutdownSignal, void 0);
        }
      }).pipe(
        Effect.repeat(Schedule.spaced(IDLE_TIMEOUT)),
        Effect.asVoid,
        Effect.forkChild,
      );
    });

    const awaitShutdown = Deferred.await(shutdownSignal);

    return { recordHeartbeat, startWatchdog, awaitShutdown };
  });

// ---------------------------------------------------------------------------
// RPC handler layer
// ---------------------------------------------------------------------------

const makeHandlersLayer = (
  watchdog: Effect.Success<ReturnType<typeof makeIdleWatchdog>>,
  procRegistry: Effect.Success<ReturnType<typeof makeProcessRegistry>>,
) =>
  DaemonRpcs.toLayer({
    heartbeat: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Heartbeat received");
        yield* watchdog.recordHeartbeat;
      }),
    spawn: (req) =>
      procRegistry.spawnProcess(req).pipe(
        Effect.catchIf(
          (e): e is Exclude<typeof e, ProcessAlreadyExists> =>
            !(e instanceof ProcessAlreadyExists),
          (e) => Effect.die(e),
        ),
      ),
    kill: (req) =>
      procRegistry.killProcess(req).pipe(
        Effect.catchIf(
          (e): e is Exclude<typeof e, ProcessNotFound> =>
            !(e instanceof ProcessNotFound),
          (e) => Effect.die(e),
        ),
      ),
    watch: (req) => procRegistry.watchProcess(req),
  });
