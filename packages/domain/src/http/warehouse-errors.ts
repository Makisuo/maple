import { Schema } from "effect"

// Pure error definitions for warehouse queries. This module imports ONLY
// `effect` Schema — never `effect/unstable/httpapi` — so non-HTTP consumers
// (`@maple/query-engine/observability`, the CLI executors) can import these
// classes without pulling the HttpApi AST builder into their bundles.
// `warehouse.ts` re-exports everything here and owns the `WarehouseApiGroup`.
//
// Each distinct warehouse failure mode is its own `Schema.TaggedErrorClass`,
// discriminated by `_tag` / `instanceof` / `catchTags` rather than a stringly-
// typed `category` field. This used to be a single `WarehouseQueryError` with a
// `category` literal; it was kept that way to avoid adding TaggedError classes
// to every endpoint's error union (a concern that adding ~7 classes × ~30
// endpoints would blow Cloudflare Workers' script-startup CPU budget — error
// 10021). That concern is obsolete: `apps/api/src/worker.ts` lazy-imports the
// route graph behind `await import("./app")`, so Cloudflare's upload-validation
// pass never evaluates these Schema ASTs (they build on the first request,
// under the far larger per-request budget).

// Fields common to every warehouse error. `cause` carries the original thrown
// defect; `clickhouse*` carry CH diagnostics extracted by `mapWarehouseError`.
const warehouseErrorBaseFields = {
	message: Schema.String,
	pipeName: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
	clickhouseCode: Schema.optional(Schema.String),
	clickhouseType: Schema.optional(Schema.String),
}

/** Generic ClickHouse/SQL query failure — the default when nothing more specific matches. */
export class WarehouseQueryError extends Schema.TaggedErrorClass<WarehouseQueryError>()(
	"@maple/http/errors/WarehouseQueryError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 502 },
) {}

/** Transient query-backend / CDN / network failure. Retryable; mapped to 503. */
export class WarehouseUpstreamError extends Schema.TaggedErrorClass<WarehouseUpstreamError>()(
	"@maple/http/errors/WarehouseUpstreamError",
	{ ...warehouseErrorBaseFields, upstreamStatus: Schema.optional(Schema.Number) },
	{ httpApiStatus: 503 },
) {}

/** Upstream 401/403 or database credentials failure. */
export class WarehouseAuthError extends Schema.TaggedErrorClass<WarehouseAuthError>()(
	"@maple/http/errors/WarehouseAuthError",
	{ ...warehouseErrorBaseFields, upstreamStatus: Schema.optional(Schema.Number) },
	{ httpApiStatus: 502 },
) {}

/** Backend/database is misconfigured (unknown database/table, bad URL, etc.). */
export class WarehouseConfigError extends Schema.TaggedErrorClass<WarehouseConfigError>()(
	"@maple/http/errors/WarehouseConfigError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 502 },
) {}

/** Maple's query client could not decode/consume the response. */
export class WarehouseClientError extends Schema.TaggedErrorClass<WarehouseClientError>()(
	"@maple/http/errors/WarehouseClientError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 502 },
) {}

/**
 * A BYO ClickHouse cluster is missing a column or has the wrong type for one
 * Maple expects; remediated by running schema apply on the cluster. The MCP
 * layer enriches this with an actionable hint.
 */
export class WarehouseSchemaDriftError extends Schema.TaggedErrorClass<WarehouseSchemaDriftError>()(
	"@maple/http/errors/WarehouseSchemaDriftError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 502 },
) {}

/**
 * ClickHouse's analyzer rejected the SQL Maple generated — a type mismatch
 * between `if()` arms or `UNION` branches, an illegal argument type, an
 * ambiguous column. This is a **Maple bug**, not a customer problem: the same
 * SQL fails for every org on every cluster, no retry helps, and no schema apply
 * fixes it.
 *
 * It is split out from `WarehouseQueryError` (which means "the warehouse said
 * no" and covers genuinely external failures) so it can be alerted on and so the
 * UI stops telling people to check their database. Mapped to 500 — the fault is
 * ours.
 */
export class WarehouseMalformedQueryError extends Schema.TaggedErrorClass<WarehouseMalformedQueryError>()(
	"@maple/http/errors/WarehouseMalformedQueryError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 500 },
) {}

/** A query exceeded a ClickHouse resource quota. Mapped to 429. */
export class WarehouseQuotaExceededError extends Schema.TaggedErrorClass<WarehouseQuotaExceededError>()(
	"@maple/http/errors/WarehouseQuotaExceededError",
	{
		...warehouseErrorBaseFields,
		setting: Schema.Literals(["max_execution_time", "max_memory_usage", "max_threads"]),
	},
	{ httpApiStatus: 429 },
) {}

/**
 * A precondition for running a warehouse query was not met (empty org scope,
 * missing OrgId filter, unsupported pipe). This is a bad request, not a backend
 * failure — mapped to 400.
 */
export class WarehouseValidationError extends Schema.TaggedErrorClass<WarehouseValidationError>()(
	"@maple/http/errors/WarehouseValidationError",
	warehouseErrorBaseFields,
	{ httpApiStatus: 400 },
) {}

/** Every warehouse error. Use this as the error channel of warehouse-facing effects. */
export type WarehouseError =
	| WarehouseQueryError
	| WarehouseUpstreamError
	| WarehouseAuthError
	| WarehouseConfigError
	| WarehouseClientError
	| WarehouseSchemaDriftError
	| WarehouseMalformedQueryError
	| WarehouseQuotaExceededError
	| WarehouseValidationError

/**
 * The full set of warehouse error classes, for reuse in `HttpApiEndpoint`
 * `error:` arrays. Every endpoint that can surface a warehouse error must list
 * all of them, or the HttpApi client throws when it decodes an unrecognized
 * `_tag`. Spread this (`...warehouseHttpErrors`) into each endpoint's array.
 */
export const warehouseHttpErrors = [
	WarehouseQueryError,
	WarehouseUpstreamError,
	WarehouseAuthError,
	WarehouseConfigError,
	WarehouseClientError,
	WarehouseSchemaDriftError,
	WarehouseMalformedQueryError,
	WarehouseQuotaExceededError,
	WarehouseValidationError,
] as const
