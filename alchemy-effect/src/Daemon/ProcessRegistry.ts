import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  ChildProcessSpawner,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner";
import { type SQLiteConnection } from "../SQLite/index.ts";
import { ensureAlchemyDir, PROCESSES_DIR } from "./Config.ts";
import { ProcessAlreadyExists, ProcessNotFound } from "./Errors.ts";

interface OutputMessage {
  readonly fd: "stdout" | "stderr";
  readonly text: string;
}

interface ManagedProcess {
  readonly id: string;
  readonly handle: ChildProcessHandle;
  readonly pubsub: PubSub.PubSub<OutputMessage>;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly cursors: Ref.Ref<
    HashMap.HashMap<string, { stdoutOffset: number; stderrOffset: number }>
  >;
}

type Registry = Ref.Ref<HashMap.HashMap<string, ManagedProcess>>;

export const makeProcessRegistry = (db: SQLiteConnection) =>
  Effect.gen(function* () {
    const registry: Registry = yield* Ref.make(
      HashMap.empty<string, ManagedProcess>(),
    );

    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const alchemyDir = yield* ensureAlchemyDir;
    const processesDir = pathSvc.join(alchemyDir, PROCESSES_DIR);
    yield* fs.makeDirectory(processesDir, { recursive: true });

    const spawnProcess = (req: {
      id: string;
      command: string;
      args: ReadonlyArray<string>;
      cwd?: string;
      env?: Record<string, string>;
    }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(registry);
        const existing = HashMap.get(current, req.id);

        if (Option.isSome(existing)) {
          const alive = yield* existing.value.handle.isRunning;
          if (alive) {
            return yield* Effect.fail(new ProcessAlreadyExists({ id: req.id }));
          }
          yield* Ref.update(registry, HashMap.remove(req.id));
        }

        const logDir = pathSvc.join(processesDir, req.id);
        yield* fs.makeDirectory(logDir, { recursive: true });
        const stdoutLogPath = pathSvc.join(logDir, "stdout.log");
        const stderrLogPath = pathSvc.join(logDir, "stderr.log");

        yield* fs
          .writeFile(stdoutLogPath, new Uint8Array(0))
          .pipe(Effect.ignore);
        yield* fs
          .writeFile(stderrLogPath, new Uint8Array(0))
          .pipe(Effect.ignore);

        const cmd = ChildProcess.make(req.command, req.args as string[], {
          cwd: req.cwd,
          env: req.env,
        });
        const childScope = yield* Scope.make();
        const handle = yield* Scope.provide(spawner.spawn(cmd), childScope);

        const insertStmt = yield* db.prepare(
          "INSERT OR REPLACE INTO processes (id, pid, command, args, cwd) VALUES (?, ?, ?, ?, ?)",
        );
        yield* insertStmt.run(
          req.id,
          handle.pid,
          req.command,
          JSON.stringify(req.args),
          req.cwd ?? null,
        );

        const pubsub = yield* PubSub.unbounded<OutputMessage>();
        const cursors = yield* Ref.make(
          HashMap.empty<
            string,
            { stdoutOffset: number; stderrOffset: number }
          >(),
        );

        const collectStream = (
          stream: Stream.Stream<Uint8Array, any>,
          fd: "stdout" | "stderr",
          logPath: string,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const logFile = yield* fs.open(logPath, { flag: "a" });

              yield* stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    yield* logFile.writeAll(chunk);
                    const text = new TextDecoder().decode(chunk);
                    yield* PubSub.publish(pubsub, { fd, text });
                  }),
                ),
                Effect.ignore,
              );
            }),
          );

        yield* collectStream(handle.stdout, "stdout", stdoutLogPath).pipe(
          Effect.forkDetach,
        );
        yield* collectStream(handle.stderr, "stderr", stderrLogPath).pipe(
          Effect.forkDetach,
        );

        const managed: ManagedProcess = {
          id: req.id,
          handle,
          pubsub,
          stdoutLogPath,
          stderrLogPath,
          cursors,
        };

        yield* Ref.update(registry, HashMap.set(req.id, managed));

        return { pid: handle.pid };
      });

    const killProcess = (req: { id: string; killSignal?: string }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(registry);
        const existing = HashMap.get(current, req.id);

        if (Option.isNone(existing)) {
          return yield* Effect.fail(new ProcessNotFound({ id: req.id }));
        }

        const proc = existing.value;
        yield* proc.handle
          .kill(
            req.killSignal
              ? { killSignal: req.killSignal as ChildProcess.Signal }
              : undefined,
          )
          .pipe(Effect.ignore);
        yield* proc.handle.exitCode.pipe(Effect.ignore);

        const delStmt = yield* db.prepare("DELETE FROM processes WHERE id = ?");
        yield* delStmt.run(req.id);

        yield* Ref.update(registry, HashMap.remove(req.id));
      });

    const watchProcess = (req: { id: string; clientId: string }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const current = yield* Ref.get(registry);
          const existing = HashMap.get(current, req.id);

          if (Option.isNone(existing)) {
            return yield* Effect.fail(new ProcessNotFound({ id: req.id }));
          }

          const proc = existing.value;

          const allCursors = yield* Ref.get(proc.cursors);
          const cursor = Option.getOrElse(
            HashMap.get(allCursors, req.clientId),
            () => ({ stdoutOffset: 0, stderrOffset: 0 }),
          );

          const replayFile = (
            logPath: string,
            fd: "stdout" | "stderr",
            offset: number,
          ) =>
            Effect.gen(function* () {
              const content = yield* fs
                .readFile(logPath)
                .pipe(
                  Effect.catchTag("PlatformError", () =>
                    Effect.succeed(new Uint8Array(0)),
                  ),
                );
              if (offset >= content.byteLength)
                return { messages: [] as OutputMessage[], newOffset: offset };
              const chunk = content.slice(offset);
              const text = new TextDecoder().decode(chunk);
              return {
                messages: [{ fd, text } as OutputMessage],
                newOffset: content.byteLength,
              };
            });

          const stdoutReplay = yield* replayFile(
            proc.stdoutLogPath,
            "stdout",
            cursor.stdoutOffset,
          );
          const stderrReplay = yield* replayFile(
            proc.stderrLogPath,
            "stderr",
            cursor.stderrOffset,
          );

          const replayMessages = [
            ...stdoutReplay.messages,
            ...stderrReplay.messages,
          ].filter((m) => m.text.length > 0);

          const cursorUpdate = Stream.fromEffect(
            Effect.as(
              Ref.update(
                proc.cursors,
                HashMap.set(req.clientId, {
                  stdoutOffset: stdoutReplay.newOffset,
                  stderrOffset: stderrReplay.newOffset,
                }),
              ),
              undefined as never,
            ),
          ).pipe(Stream.filter((_): _ is never => false));

          const replayStream = Stream.concat(
            Stream.fromIterable(replayMessages),
            cursorUpdate,
          );

          const isRunning = yield* proc.handle.isRunning.pipe(
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          );

          if (!isRunning) {
            return replayStream;
          }

          const liveStream = Stream.fromPubSub(proc.pubsub).pipe(
            Stream.tap((msg) =>
              Ref.update(proc.cursors, (cursorsMap) => {
                const cur = Option.getOrElse(
                  HashMap.get(cursorsMap, req.clientId),
                  () => ({
                    stdoutOffset: cursor.stdoutOffset,
                    stderrOffset: cursor.stderrOffset,
                  }),
                );
                const byteLen = new TextEncoder().encode(msg.text).byteLength;
                return HashMap.set(cursorsMap, req.clientId, {
                  stdoutOffset:
                    cur.stdoutOffset + (msg.fd === "stdout" ? byteLen : 0),
                  stderrOffset:
                    cur.stderrOffset + (msg.fd === "stderr" ? byteLen : 0),
                });
              }),
            ),
          );

          return Stream.concat(replayStream, liveStream);
        }),
      );

    return { registry, spawnProcess, killProcess, watchProcess };
  });
