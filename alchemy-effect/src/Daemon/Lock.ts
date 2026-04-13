import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { ensureAlchemyDir, LOCK_DIR_NAME, PID_FILE_NAME } from "./Config.ts";
import { DaemonAlreadyRunning } from "./Errors.ts";

const STALE_THRESHOLD = Duration.seconds(10);
const LOCK_UPDATE_INTERVAL = Duration.seconds(4);

export const acquireLock = (shutdownSignal: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* ensureAlchemyDir;
    const lockDir = path.join(dir, LOCK_DIR_NAME);
    const pidFile = path.join(lockDir, PID_FILE_NAME);

    const tryMkdir = Effect.gen(function* () {
      yield* fs.makeDirectory(lockDir);
      yield* fs.writeFileString(pidFile, String(process.pid));
    });

    yield* tryMkdir.pipe(
      Effect.catchTag("PlatformError", (err) => {
        if (err.reason._tag !== "AlreadyExists") return Effect.fail(err);

        return Effect.gen(function* () {
          const stale = yield* isLockStale(pidFile);
          if (!stale) {
            const pid = yield* readLockPid(lockDir);
            return yield* new DaemonAlreadyRunning({ pid });
          }

          const pid = yield* readLockPid(lockDir);
          if (pid !== undefined) {
            const alive = yield* isProcessAlive(pid);
            if (alive) {
              return yield* new DaemonAlreadyRunning({ pid });
            }
          }

          yield* Effect.logWarning(
            `Removing stale lock (previous pid: ${pid ?? "unknown"})`,
          );
          yield* fs.remove(lockDir, { recursive: true, force: true });

          yield* tryMkdir.pipe(
            Effect.catchTag("PlatformError", (retryErr) =>
              retryErr.reason._tag !== "AlreadyExists"
                ? Effect.fail<DaemonAlreadyRunning | typeof retryErr>(retryErr)
                : Effect.gen(function* () {
                    const winnerPid = yield* readLockPid(lockDir);
                    return yield* new DaemonAlreadyRunning({ pid: winnerPid });
                  }),
            ),
          );
        });
      }),
    );

    const updaterFiber = yield* startLockUpdater(lockDir, shutdownSignal);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(updaterFiber).pipe(Effect.ignore);
        yield* fs
          .remove(lockDir, { recursive: true, force: true })
          .pipe(Effect.ignore);
      }),
    );
  });

export const isProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const readLockPid = (lockDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pidFile = path.join(lockDir, PID_FILE_NAME);
    const contents = yield* fs
      .readFileString(pidFile)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    const pid = parseInt(contents.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  });

const isLockStale = (pidFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(pidFile)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)));
    if (info === undefined) return true;
    const mtime = Option.getOrElse(info.mtime, () => new Date(0));
    const age = Date.now() - mtime.getTime();
    return age > Duration.toMillis(STALE_THRESHOLD);
  });

const startLockUpdater = (
  lockDir: string,
  shutdownSignal: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pidFile = path.join(lockDir, PID_FILE_NAME);
    const lastMtime = yield* Ref.make<number>(Date.now());

    const touch = Effect.gen(function* () {
      const info = yield* fs
        .stat(pidFile)
        .pipe(
          Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
        );

      if (info === undefined) {
        yield* Effect.logError("Lock compromised: pid file disappeared");
        yield* Deferred.succeed(shutdownSignal, void 0);
        return;
      }

      const currentMtime = Option.getOrElse(info.mtime, () => new Date(0));
      const expected = yield* Ref.get(lastMtime);

      if (Math.abs(currentMtime.getTime() - expected) > 1000) {
        yield* Effect.logError(
          `Lock compromised: mtime changed externally (expected ${expected}, got ${currentMtime.getTime()})`,
        );
        yield* Deferred.succeed(shutdownSignal, void 0);
        return;
      }

      const now = new Date();
      yield* fs.utimes(pidFile, now, now).pipe(
        Effect.catchTag("PlatformError", (err) => {
          Effect.logWarning(`Failed to update lock mtime: ${err.message}`);
          return Effect.void;
        }),
      );
      yield* Ref.set(lastMtime, now.getTime());
    });

    return yield* touch.pipe(
      Effect.repeat(Schedule.spaced(LOCK_UPDATE_INTERVAL)),
      Effect.asVoid,
      Effect.forkChild,
    );
  });
