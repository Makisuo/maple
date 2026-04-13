export {
  ALCHEMY_DIR,
  DB_FILE,
  ensureAlchemyDir,
  LOCK_DIR_NAME,
  PID_FILE_NAME,
  PROCESSES_DIR,
  resolveAlchemyDir,
  resolveSocketPath,
  SOCKET_FILE,
} from "./Config.ts";

export { Daemon, DaemonLive, makeClient } from "./Client.ts";
export type { DaemonClient } from "./Client.ts";

export {
  DaemonAlreadyRunning,
  DaemonConnectFailed,
  DaemonSocketNotReady,
  LockCompromised,
  ProcessAlreadyExists,
  ProcessNotFound,
} from "./Errors.ts";

export { DaemonRpcs } from "./RpcSchema.ts";

export { main as daemonMain } from "./RpcServer.ts";
