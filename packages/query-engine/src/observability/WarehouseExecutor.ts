import { Context, type Effect, type Option } from "effect"
import type { WarehouseError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import type { CompiledQueryInput } from "../ch"
import type { SqlQueryOptions } from "../profiles"

/**
 * The error channel of every `WarehouseExecutor` method. This is the warehouse
 * error union from `@maple/domain/http/warehouse-errors` (the PURE module — no
 * HttpApi dependency), so this subpath and its CLI consumers stay free of the
 * HttpApi AST builder.
 */
export type WarehouseExecutorError = WarehouseError

export interface WarehouseExecutorApi {
	/** The org ID for the current tenant — needed for raw SQL queries. */
	readonly orgId: string

	readonly query: <T = any>(
		pipe: WarehouseQueryName,
		params: Record<string, unknown>,
		options?: SqlQueryOptions,
	) => Effect.Effect<{ data: ReadonlyArray<T> }, WarehouseExecutorError>

	/**
	 * Execute a compiled query. The SQL MUST include an OrgId filter.
	 *
	 * Takes the unrun `CH.compile` as readily as its result: a `QueryBuilderError`
	 * from a query built out of Maple's own definitions is a defect, and this is
	 * the one place that says so. See `CompiledQueryInput`.
	 */
	readonly compiledQuery: <T>(
		compiled: CompiledQueryInput<T>,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseExecutorError>

	readonly compiledQueryFirst: <T>(
		compiled: CompiledQueryInput<T>,
		options?: SqlQueryOptions,
	) => Effect.Effect<Option.Option<T>, WarehouseExecutorError>
}

export class WarehouseExecutor extends Context.Service<WarehouseExecutor, WarehouseExecutorApi>()(
	"@maple/query-engine/observability/WarehouseExecutor",
) {}
