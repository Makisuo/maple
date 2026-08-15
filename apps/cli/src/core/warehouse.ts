import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import {
	WarehouseExecutor,
	type WarehouseExecutorApi,
	type SqlQueryOptions,
} from "@maple/query-engine/observability"
import { WarehouseConfigError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { Mode } from "./mode"
import { makeLocalWarehouseExecutorApi } from "./executor"
import { makeRemoteWarehouseExecutorApi } from "./remote-executor"

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
		const client = yield* HttpClient.HttpClient
		const getExecutor = yield* Effect.cached(
			mode.resolve.pipe(
				Effect.map(
					(m): WarehouseExecutorApi =>
						m._tag === "local"
							? makeLocalWarehouseExecutorApi(m.baseUrl)
							: makeRemoteWarehouseExecutorApi(client, m.apiUrl, m.token, m.orgId ?? ""),
				),
				Effect.mapError((e) => new WarehouseConfigError({ message: e.message, pipeName: "mode" })),
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
