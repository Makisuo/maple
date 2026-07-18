import { Effect, Layer } from "effect"
import {
	WarehouseExecutor,
	type WarehouseExecutorShape,
	type SqlQueryOptions,
} from "@maple/query-engine/observability"
import { WarehouseConfigError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { Mode } from "./mode"
import { makeLocalWarehouseExecutorShape } from "./executor"
import { makeRemoteWarehouseExecutorShape } from "./remote-executor"

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
		const getShape = yield* Effect.cached(
			mode.resolve.pipe(
				Effect.map(
					(m): WarehouseExecutorShape =>
						m._tag === "local"
							? makeLocalWarehouseExecutorShape(m.baseUrl)
							: makeRemoteWarehouseExecutorShape(m.apiUrl, m.token, m.orgId ?? ""),
				),
				Effect.mapError((e) => new WarehouseConfigError({ message: e.message, pipeName: "mode" })),
			),
		)
		return WarehouseExecutor.of({
			orgId: "",
			query: <T>(pipe: string, params: Record<string, unknown>, options?: SqlQueryOptions) =>
				getShape.pipe(
					Effect.flatMap((shape) => shape.query<T>(pipe as WarehouseQueryName, params, options)),
				),
			sqlQuery: <T = Record<string, unknown>>(sql: string, options?: SqlQueryOptions) =>
				getShape.pipe(Effect.flatMap((shape) => shape.sqlQuery<T>(sql, options))),
			compiledQuery: (compiled, options?: SqlQueryOptions) =>
				getShape.pipe(Effect.flatMap((shape) => shape.compiledQuery(compiled, options))),
			compiledQueryFirst: (compiled, options?: SqlQueryOptions) =>
				getShape.pipe(Effect.flatMap((shape) => shape.compiledQueryFirst(compiled, options))),
		})
	}),
)
