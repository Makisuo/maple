import * as Effect from "effect/Effect";
import { Daemon } from "./Daemon/Client.ts";

export const spawn = Effect.fnUntraced(function* (
  id: string,
  command: string,
  args?: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) {
  const daemon = yield* Daemon;
  const handle = yield* daemon.spawn({
    id,
    command,
    args: args ?? [],
    ...options,
  });

  daemon.watch({
    clientId: "my",
    id,
  });
  return handle;
});
