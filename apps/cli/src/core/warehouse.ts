import { Effect, Layer } from "effect"
import { WarehouseExecutor, type SqlQueryOptions } from "@maple/query-engine/observability"
import { WarehouseConfigError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { Mode } from "./mode"
import { makeLocalWarehouseExecutorApi } from "./executor"

/**
 * Provides `WarehouseExecutor` whose concrete backend (local chDB vs remote
 * warehouse) is resolved lazily, on first query — NOT at layer-build time.
 *
 * This matters because `Command.run`'s requirement union includes
 * WarehouseExecutor even for commands that never query (login/logout/whoami).
 * Resolving the mode eagerly at build time would make those commands fail when
 * no backend is configured. Deferring resolution into the methods keeps the
 * layer always-constructible, while `Effect.cached` resolves the mode at most
 * once per process.
 *
 * Note: `orgId` is intentionally empty. No CLI command reads `executor.orgId`
 * (the local executor injects "local" and the remote server injects the tenant
 * org), so it is never used on this path.
 */
export const WarehouseExecutorFromMode = Layer.effect(
	WarehouseExecutor,
	Effect.gen(function* () {
		const mode = yield* Mode
		const getExecutor = yield* Effect.cached(
			mode.resolve.pipe(
				Effect.flatMap((m) =>
					m._tag === "local"
						? Effect.succeed(makeLocalWarehouseExecutorApi(m.baseUrl))
						: // Remote mode never reaches the executor: `operations.ts`
							// dispatches to the v2 client before asking for one. Anything
							// that lands here is an operation that forgot to branch, so
							// fail loudly rather than silently querying the local store.
							Effect.fail(
								new WarehouseConfigError({
									message:
										"Remote mode does not use the warehouse executor — this operation is missing its v2 dispatch.",
									pipeName: "mode",
								}),
							),
				),
				Effect.mapError((e) =>
					e instanceof WarehouseConfigError
						? e
						: new WarehouseConfigError({ message: e.message, pipeName: "mode" }),
				),
			),
		)
		return WarehouseExecutor.of({
			orgId: "",
			query: <T>(pipe: string, params: Record<string, unknown>, options?: SqlQueryOptions) =>
				getExecutor.pipe(
					Effect.flatMap((executor) =>
						executor.query<T>(pipe as WarehouseQueryName, params, options),
					),
				),
			compiledQuery: (compiled, options?: SqlQueryOptions) =>
				getExecutor.pipe(Effect.flatMap((executor) => executor.compiledQuery(compiled, options))),
			compiledQueryFirst: (compiled, options?: SqlQueryOptions) =>
				getExecutor.pipe(
					Effect.flatMap((executor) => executor.compiledQueryFirst(compiled, options)),
				),
		})
	}),
)
