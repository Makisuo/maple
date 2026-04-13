import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { D1Database } from "./D1Database.ts";
import { DatabaseBinding } from "./D1DatabaseBinding.ts";

export interface D1ConnectionClient {
  /**
   * An Effect that resolves to the raw underlying Cloudflare D1Database binding.
   * Use this when you need direct access for libraries like Better Auth.
   */
  raw: Effect.Effect<runtime.D1Database>;
  /**
   * Prepare a SQL query statement for later execution.
   */
  prepare: (query: string) => Effect.Effect<runtime.D1PreparedStatement>;
  /**
   * Execute raw SQL without prepared statements.
   */
  exec: (query: string) => Effect.Effect<runtime.D1ExecResult>;
  /**
   * Send multiple prepared statements in a single call.
   * Statements execute sequentially and are rolled back on failure.
   */
  batch: <T = unknown>(
    statements: runtime.D1PreparedStatement[],
  ) => Effect.Effect<runtime.D1Result<T>[]>;
}

export class D1Connection extends Binding.Service<
  D1Connection,
  (database: D1Database) => Effect.Effect<D1ConnectionClient>
>()("Cloudflare.D1.Connection") {}

export const D1ConnectionLive = Layer.effect(
  D1Connection,
  Effect.gen(function* () {
    const Policy = yield* D1ConnectionPolicy;

    return Effect.fn(function* (database: D1Database) {
      yield* Policy(database);
      const d1 = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[database.LogicalId]! as runtime.D1Database),
        Effect.cached,
      );

      return {
        raw: d1,
        prepare: (query: string) =>
          d1.pipe(Effect.map((d1) => d1.prepare(query))),
        exec: (query: string) =>
          d1.pipe(Effect.flatMap((d1) => Effect.promise(() => d1.exec(query)))),
        batch: <T = unknown>(statements: runtime.D1PreparedStatement[]) =>
          d1.pipe(
            Effect.flatMap((d1) =>
              Effect.promise(() => d1.batch<T>(statements)),
            ),
          ),
      } satisfies D1ConnectionClient;
    });
  }),
);

export class D1ConnectionPolicy extends Binding.Policy<
  D1ConnectionPolicy,
  (database: D1Database) => Effect.Effect<void>
>()("Cloudflare.D1.Connection") {}

export const D1ConnectionPolicyLive =
  D1ConnectionPolicy.layer.succeed(DatabaseBinding);
