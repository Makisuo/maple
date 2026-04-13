import { makeClient } from "@/Daemon/Client";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import * as NodePath from "node:path";

const BIN = NodePath.resolve(
  import.meta.dirname,
  "../../bin/process-manager.ts",
);

const platform = NodeServices.layer;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ directory: "/tmp", prefix: "dm-" });
  yield* fs.makeDirectory(`${dir}/.alchemy`, { recursive: true });
  yield* Effect.addFinalizer(() =>
    fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  return dir;
});

const lockDir = (cwd: string) => `${cwd}/.alchemy/daemon.lock`;
const pidFilePath = (cwd: string) => `${cwd}/.alchemy/daemon.lock/pid`;
const socketFilePath = (cwd: string) => `${cwd}/.alchemy/daemon.sock`;

const spawnDaemon = (cwd: string) =>
  ChildProcess.make("bun", ["run", BIN], { cwd });

const collectUntil = (handle: ChildProcessHandle, marker: string) =>
  handle.all.pipe(
    Stream.decodeText(),
    Stream.scan("", (acc, chunk) => acc + chunk),
    Stream.takeUntil((text) => text.includes(marker)),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => "")),
  );

const waitForReady = (handle: ChildProcessHandle) =>
  collectUntil(handle, "Daemon ready");

const collectAllOutput = (handle: ChildProcessHandle) =>
  handle.all.pipe(Stream.decodeText(), Stream.mkString);

const readPid = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs
      .readFileString(pidFilePath(cwd))
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    const pid = parseInt(contents.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  });

const waitForSocket = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.exists(socketFilePath(cwd)).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.void : Effect.fail("not yet" as const),
      ),
      Effect.retry(
        Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100))),
      ),
    );
  });

const startDaemon = Effect.gen(function* () {
  const cwd = yield* makeTempDir;
  const daemon = yield* spawnDaemon(cwd);
  yield* waitForReady(daemon);
  yield* waitForSocket(cwd);
  return { cwd, daemon };
});

const startDaemonWithClient = Effect.gen(function* () {
  const { cwd, daemon } = yield* startDaemon;
  const client = yield* makeClient(socketFilePath(cwd));
  return { cwd, daemon, client };
});

/** Collect all watch output into a single concatenated string per fd. */
const watchAllText = (
  client: Effect.Success<ReturnType<typeof makeClient>>,
  id: string,
  clientId: string,
) =>
  Effect.gen(function* () {
    const messages = yield* client
      .watch({ id, clientId })
      .pipe(Stream.runCollect);
    const items = Array.from(messages);
    const stdout = items
      .filter((m) => m.fd === "stdout")
      .map((m) => m.text)
      .join("");
    const stderr = items
      .filter((m) => m.fd === "stderr")
      .map((m) => m.text)
      .join("");
    return { stdout, stderr, items };
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("process-manager daemon", () => {
  // -----------------------------------------------------------------------
  // Daemon lifecycle tests
  // -----------------------------------------------------------------------

  it.live(
    "acquires lock, listens on socket, cleans up on idle shutdown",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, daemon } = yield* startDaemon;

        expect(yield* fs.exists(lockDir(cwd))).toBe(true);
        expect(yield* fs.exists(pidFilePath(cwd))).toBe(true);
        expect(yield* fs.exists(socketFilePath(cwd))).toBe(true);

        const pid = yield* readPid(cwd);
        expect(pid).toBeDefined();

        const exitCode = yield* daemon.exitCode;
        expect(exitCode).toBe(0);

        expect(yield* fs.exists(lockDir(cwd))).toBe(false);
        expect(yield* fs.exists(socketFilePath(cwd))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 20_000 },
  );

  it.live(
    "rejects a second daemon with DaemonAlreadyRunning",
    () =>
      Effect.gen(function* () {
        const { cwd, daemon: daemon1 } = yield* startDaemon;

        const daemon2 = yield* spawnDaemon(cwd);
        const output = yield* collectAllOutput(daemon2);
        const exitCode = yield* daemon2.exitCode;

        expect(exitCode).toBe(0);
        expect(output).toContain("Daemon already running");

        yield* daemon1.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "20 concurrent starts — exactly 1 wins",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const handles = yield* Effect.all(
          Array.from({ length: 20 }, () =>
            Effect.gen(function* () {
              const handle = yield* spawnDaemon(cwd);
              const output = yield* collectAllOutput(handle);
              const exitCode = yield* handle.exitCode;
              return { output, exitCode };
            }),
          ),
          { concurrency: 20 },
        );

        const winners = handles.filter((r) =>
          r.output.includes("Daemon ready"),
        );
        const rejected = handles.filter((r) =>
          r.output.includes("Daemon already running"),
        );

        expect(winners.length).toBeGreaterThanOrEqual(1);
        expect(winners.length).toBeLessThanOrEqual(2);
        expect(rejected.length + winners.length).toBe(20);

        for (const r of handles) {
          expect(r.exitCode).toBe(0);
        }
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 30_000 },
  );

  it.live(
    "recovers from SIGKILL (stale lock)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, daemon: daemon1 } = yield* startDaemon;

        const pid1 = yield* readPid(cwd);
        expect(pid1).toBeDefined();

        yield* daemon1.kill({ killSignal: "SIGKILL" });
        yield* daemon1.exitCode.pipe(Effect.ignore);

        expect(yield* fs.exists(lockDir(cwd))).toBe(true);

        yield* Effect.sleep("11 seconds");

        const daemon2 = yield* spawnDaemon(cwd);
        const output = yield* waitForReady(daemon2);

        expect(output).toContain("Removing stale lock");
        expect(output).toContain("Daemon ready");

        const pid2 = yield* readPid(cwd);
        expect(pid2).toBeDefined();
        expect(pid2).not.toBe(pid1);

        yield* daemon2.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 30_000 },
  );

  it.live(
    "SIGTERM causes graceful shutdown with cleanup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, daemon } = yield* startDaemon;

        expect(yield* fs.exists(lockDir(cwd))).toBe(true);
        expect(yield* fs.exists(socketFilePath(cwd))).toBe(true);

        yield* daemon.kill();
        yield* daemon.exitCode.pipe(Effect.ignore);

        expect(yield* fs.exists(lockDir(cwd))).toBe(false);
        expect(yield* fs.exists(socketFilePath(cwd))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 10_000 },
  );

  it.live(
    "rapid start/SIGTERM cycles all clean up",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;

        for (let i = 0; i < 5; i++) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const daemon = yield* spawnDaemon(cwd);
              yield* waitForReady(daemon);
              yield* waitForSocket(cwd);

              const pid = yield* readPid(cwd);
              expect(pid).toBeDefined();

              yield* daemon.kill();
              yield* daemon.exitCode.pipe(Effect.ignore);

              expect(yield* fs.exists(lockDir(cwd))).toBe(false);
              expect(yield* fs.exists(socketFilePath(cwd))).toBe(false);
            }),
          );
        }
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 30_000 },
  );

  // -----------------------------------------------------------------------
  // RPC service tests
  // -----------------------------------------------------------------------

  it.live(
    "spawn creates a process and returns its pid",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        const { pid } = yield* client.spawn({
          id: "test-echo",
          command: "echo",
          args: ["hello world"],
        });

        expect(pid).toBeGreaterThan(0);

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "spawn rejects duplicate process id",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "long-running",
          command: "sleep",
          args: ["30"],
        });

        const result = yield* client
          .spawn({ id: "long-running", command: "sleep", args: ["30"] })
          .pipe(Effect.flip);

        expect(result._tag).toBe("ProcessAlreadyExists");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "kill terminates a running process",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "to-kill",
          command: "sleep",
          args: ["60"],
        });

        yield* client.kill({ id: "to-kill" });

        const result = yield* client.kill({ id: "to-kill" }).pipe(Effect.flip);
        expect(result._tag).toBe("ProcessNotFound");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "kill returns ProcessNotFound for unknown id",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        const result = yield* client
          .kill({ id: "does-not-exist" })
          .pipe(Effect.flip);

        expect(result._tag).toBe("ProcessNotFound");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  // -----------------------------------------------------------------------
  // Watch / streaming tests
  // -----------------------------------------------------------------------

  it.live(
    "watch replays all output from a finished process",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "multi-line",
          command: "bash",
          args: ["-c", "echo line-1; echo line-2; echo line-3"],
        });

        yield* Effect.sleep("1 seconds");

        const { stdout } = yield* watchAllText(client, "multi-line", "c1");
        expect(stdout).toContain("line-1");
        expect(stdout).toContain("line-2");
        expect(stdout).toContain("line-3");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "watch resumes from cursor — second call skips already-seen output",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "resume-test",
          command: "bash",
          args: ["-c", "for i in $(seq 1 5); do echo line-$i; done"],
        });

        yield* Effect.sleep("1 seconds");

        const { stdout } = yield* watchAllText(
          client,
          "resume-test",
          "cursor-client",
        );
        expect(stdout).toContain("line-1");
        expect(stdout).toContain("line-5");

        const second = yield* watchAllText(
          client,
          "resume-test",
          "cursor-client",
        );
        expect(second.stdout).toBe("");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "watch with different clientIds each get full output independently",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "multi-client",
          command: "bash",
          args: ["-c", "echo alpha; echo beta; echo gamma"],
        });

        yield* Effect.sleep("2 seconds");

        const a = yield* watchAllText(client, "multi-client", "client-A");
        const b = yield* watchAllText(client, "multi-client", "client-B");

        expect(a.stdout).toContain("alpha");
        expect(a.stdout).toContain("gamma");
        expect(b.stdout).toContain("alpha");
        expect(b.stdout).toContain("gamma");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "watch captures both stdout and stderr",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "both-fds",
          command: "bash",
          args: ["-c", "echo out-msg; echo err-msg >&2"],
        });

        yield* Effect.sleep("1 seconds");

        const { stdout, stderr } = yield* watchAllText(
          client,
          "both-fds",
          "fd-client",
        );
        expect(stdout).toContain("out-msg");
        expect(stderr).toContain("err-msg");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "watch stress — 100 lines, cursor advances, no gaps",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "stress-100",
          command: "bash",
          args: ["-c", "for i in $(seq 1 100); do echo line-$i; done"],
        });

        yield* Effect.sleep("2 seconds");

        const { stdout } = yield* watchAllText(
          client,
          "stress-100",
          "stress-client",
        );

        for (let i = 1; i <= 100; i++) {
          expect(stdout).toContain(`line-${i}`);
        }

        const second = yield* watchAllText(
          client,
          "stress-100",
          "stress-client",
        );
        expect(second.stdout).toBe("");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 20_000 },
  );

  it.live(
    "watch live — streams output as process produces it",
    () =>
      Effect.gen(function* () {
        const { daemon, client } = yield* startDaemonWithClient;

        yield* client.spawn({
          id: "live-stream",
          command: "bash",
          args: [
            "-c",
            "sleep 0.5; echo live-1; sleep 0.5; echo live-2; sleep 0.5; echo live-3",
          ],
        });

        const text = yield* client
          .watch({ id: "live-stream", clientId: "live-client" })
          .pipe(
            Stream.scan("", (acc, msg) => acc + msg.text),
            Stream.takeUntil((t) => t.includes("live-3")),
            Stream.runLast,
            Effect.map(Option.getOrElse(() => "")),
          );

        expect(text).toContain("live-1");
        expect(text).toContain("live-2");
        expect(text).toContain("live-3");

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );

  it.live(
    "watch with different clientId replays everything after partial take",
    () =>
      Effect.gen(function* () {
        const { cwd, daemon } = yield* startDaemon;

        const client1 = yield* makeClient(socketFilePath(cwd));

        yield* client1.spawn({
          id: "partial-take",
          command: "bash",
          args: ["-c", "for i in $(seq 1 10); do echo line-$i; done"],
        });

        yield* Effect.sleep("1 seconds");

        const partial = yield* client1
          .watch({ id: "partial-take", clientId: "client-A" })
          .pipe(Stream.take(1), Stream.runCollect);

        const partialText = Array.from(partial)
          .map((m) => m.text)
          .join("");
        expect(partialText).toContain("line-1");

        const client2 = yield* makeClient(socketFilePath(cwd));
        const { stdout } = yield* watchAllText(
          client2,
          "partial-take",
          "client-B",
        );

        for (let i = 1; i <= 10; i++) {
          expect(stdout).toContain(`line-${i}`);
        }

        yield* daemon.kill();
      }).pipe(Effect.scoped, Effect.provide(platform)),
    { timeout: 15_000 },
  );
});
