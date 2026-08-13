import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

// Pure error definitions for warehouse queries. This module imports ONLY
// `effect` Schema — never `effect/unstable/httpapi` — so non-HTTP consumers
// (`@maple/query-engine/observability`, the CLI executors) can import these
// classes without pulling the HttpApi AST builder into their bundles.
// `warehouse.ts` re-exports everything here and owns the `WarehouseApiGroup`.
//
// Each distinct warehouse failure mode is its own `Schema.TaggedError`,
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
// defect; `clickhouse*` carry CH diagnostics extracted by the warehouse classifier.
const warehouseErrorBaseFields = {
	message: Schema.String,
	pipeName: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
	clickhouseCode: Schema.optional(Schema.String),
	clickhouseType: Schema.optional(Schema.String),
}

/** Generic ClickHouse/SQL query failure — the default when nothing more specific matches. */
export class WarehouseQueryError extends HttpTaggedError<WarehouseQueryError>()(
	"@maple/http/errors/WarehouseQueryError",
	warehouseErrorBaseFields,
	{
		status: 502,
		code: "warehouse_query_failed",
		title: "Database query failed",
		message: "The database query could not be completed.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** Transient query-backend / CDN / network failure. Retryable; mapped to 503. */
export class WarehouseUpstreamError extends HttpTaggedError<WarehouseUpstreamError>()(
	"@maple/http/errors/WarehouseUpstreamError",
	{ ...warehouseErrorBaseFields, upstreamStatus: Schema.optional(Schema.Number) },
	{
		status: 503,
		code: "warehouse_unavailable",
		title: "Database is temporarily unavailable",
		message: (error) =>
			error.upstreamStatus === undefined
				? "The query backend is unreachable. Retry in a few seconds."
				: `The query backend returned ${error.upstreamStatus}. Retry in a few seconds.`,
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Upstream 401/403 or database credentials failure. */
export class WarehouseAuthError extends HttpTaggedError<WarehouseAuthError>()(
	"@maple/http/errors/WarehouseAuthError",
	{ ...warehouseErrorBaseFields, upstreamStatus: Schema.optional(Schema.Number) },
	{
		status: 502,
		code: "warehouse_auth_failed",
		title: "Database rejected our credentials",
		message: (error) =>
			error.upstreamStatus === 403
				? "The configured database credentials are missing required permissions."
				: "The configured database credentials are invalid or expired. Update them in settings.",
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
) {}

/** Backend/database is misconfigured (unknown database/table, bad URL, etc.). */
export class WarehouseConfigError extends HttpTaggedError<WarehouseConfigError>()(
	"@maple/http/errors/WarehouseConfigError",
	warehouseErrorBaseFields,
	{
		status: 502,
		code: "warehouse_config_invalid",
		title: "Database is not configured correctly",
		message: "Database is not configured correctly.",
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
) {}

/** Maple could not read the per-org warehouse routing configuration. */
export class WarehouseConfigLookupError extends HttpTaggedError<WarehouseConfigLookupError>()(
	"@maple/http/errors/WarehouseConfigLookupError",
	warehouseErrorBaseFields,
	{
		status: 503,
		code: "warehouse_config_lookup_unavailable",
		title: "Database settings are temporarily unavailable",
		message: "Maple could not load the database settings. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Maple's query client could not decode/consume the response. */
export class WarehouseClientError extends HttpTaggedError<WarehouseClientError>()(
	"@maple/http/errors/WarehouseClientError",
	warehouseErrorBaseFields,
	{
		status: 502,
		code: "warehouse_client_error",
		title: "Database response could not be decoded",
		message: "Database response could not be decoded.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/**
 * A BYO ClickHouse cluster is missing a column or has the wrong type for one
 * Maple expects; remediated by running schema apply on the cluster. The MCP
 * layer enriches this with an actionable hint.
 *
 * `kind` splits two failure modes that need opposite advice: `"cluster"`
 * (absent = cluster, for wire compatibility) means the cluster itself rejected
 * the query — run schema apply; `"decode"` means the cluster answered but the
 * rows failed Maple's own row schema — schema apply cannot fix that and the
 * presenter must not suggest it.
 */
export class WarehouseSchemaDriftError extends HttpTaggedError<WarehouseSchemaDriftError>()(
	"@maple/http/errors/WarehouseSchemaDriftError",
	{ ...warehouseErrorBaseFields, kind: Schema.optional(Schema.Literals(["cluster", "decode"])) },
	{
		status: 502,
		code: "warehouse_schema_drift",
		title: (error) =>
			error.kind === "decode"
				? "Query results did not match what Maple expected"
				: "Database schema is out of date",
		message: (error) =>
			error.kind === "decode"
				? "The database answered with rows Maple could not decode. This is likely a Maple bug, not a problem with your cluster."
				: "A column Maple expects is missing from the cluster. Run schema apply from your ClickHouse settings.",
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
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
export class WarehouseMalformedQueryError extends HttpTaggedError<WarehouseMalformedQueryError>()(
	"@maple/http/errors/WarehouseMalformedQueryError",
	warehouseErrorBaseFields,
	{
		status: 500,
		code: "warehouse_malformed_query",
		title: "This chart hit a bug in Maple",
		message:
			"Maple built a query its own database rejected. This is our fault, not a problem with your data or your cluster.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** A query exceeded a ClickHouse resource quota. Mapped to 429. */
export class WarehouseQuotaExceededError extends HttpTaggedError<WarehouseQuotaExceededError>()(
	"@maple/http/errors/WarehouseQuotaExceededError",
	{
		...warehouseErrorBaseFields,
		setting: Schema.Literals(["max_execution_time", "max_memory_usage", "max_threads"]),
	},
	{
		status: 429,
		code: "warehouse_quota_exceeded",
		title: "Query was too expensive",
		message: (error) => {
			switch (error.setting) {
				case "max_execution_time":
					return "Query exceeded the 30s execution limit. Narrow the time range or add filters."
				case "max_memory_usage":
					return "Query exceeded the memory limit. Add filters or reduce cardinality."
				case "max_threads":
					return "Query exceeded the thread limit. Try a smaller scan."
			}
		},
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

/**
 * A precondition for running a warehouse query was not met (empty org scope,
 * missing OrgId filter, unsupported pipe). This is a bad request, not a backend
 * failure — mapped to 400.
 */
export class WarehouseValidationError extends HttpTaggedError<WarehouseValidationError>()(
	"@maple/http/errors/WarehouseValidationError",
	warehouseErrorBaseFields,
	{
		status: 400,
		code: "warehouse_validation_failed",
		title: "Invalid query",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
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
	| WarehouseConfigLookupError

/** Errors possible on managed-only routes, which never read per-org routing config. */
export type ManagedWarehouseError = Exclude<WarehouseError, WarehouseConfigLookupError>

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
	WarehouseConfigLookupError,
] as const
