import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ProcessAlreadyExists, ProcessNotFound } from "./Errors.ts";

const heartbeat = Rpc.make("heartbeat", {
  success: Schema.Void,
});

const spawn = Rpc.make("spawn", {
  payload: {
    id: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optionalKey(Schema.String),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  },
  error: ProcessAlreadyExists,
  success: Schema.Struct({ pid: Schema.Number }),
});

const kill = Rpc.make("kill", {
  payload: {
    id: Schema.String,
    killSignal: Schema.optionalKey(Schema.String),
  },
  error: ProcessNotFound,
  success: Schema.Void,
});

const watch = Rpc.make("watch", {
  payload: {
    id: Schema.String,
    clientId: Schema.String,
  },
  success: Schema.Struct({
    fd: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  error: ProcessNotFound,
  stream: true,
});

export class DaemonRpcs extends RpcGroup.make(heartbeat, spawn, kill, watch) {}
