import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const ALCHEMY_DIR = ".alchemy";
export const SOCKET_FILE = "daemon.sock";
export const LOCK_DIR_NAME = "daemon.lock";
export const PID_FILE_NAME = "pid";
export const DB_FILE = "daemon.db";
export const PROCESSES_DIR = "processes";

export const resolveAlchemyDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(ALCHEMY_DIR);
});

export const ensureAlchemyDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* resolveAlchemyDir;
  yield* fs.makeDirectory(dir, { recursive: true });
  return dir;
});

export const resolveSocketPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dir = yield* resolveAlchemyDir;
  return path.join(dir, SOCKET_FILE);
});
