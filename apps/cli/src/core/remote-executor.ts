import { Effect, type Option } from "effect"
import { type WarehouseExecutorShape, type SqlQueryOptions } from "@maple/query-engine/observability"
import { WarehouseClientError, WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import { debugLog } from "../lib/debug"

const RAW_SQL_REMOTE_MESSAGE =
	"Raw SQL (`maple query`) is only available in local mode. In remote mode, use the typed commands (services, traces, errors, logs, timeseries, …)."

/**
 * A `WarehouseExecutor` shape backed by the remote Maple API's generic
 * `POST /api/tinybird/query` endpoint — the cloud counterpart to the local
 * binary's `/local/query`.
 *
 *   - `query(pipe, params)` POSTs `{ pipe, params }` with a bearer token. The
 *     server compiles the pipe with the authenticated tenant's org id (the
 *     client never sends `org_id`, so it can't scope to another org) and
 *     returns `{ data }`.
 *   - `sqlQuery` is unsupported: a generic raw-SQL passthrough against the
 *     multi-tenant warehouse would let a client read other orgs' data, so it
 *     fails with a clear message. (Every CLI command except `maple query`
 *     routes through `query`, so this only affects raw SQL.)
 */
export const makeRemoteWarehouseExecutorShape = (
	apiUrl: string,
	token: string,
	orgId: string,
): WarehouseExecutorShape => {
	const endpoint = `${apiUrl.replace(/\/$/, "")}/api/tinybird/query`
	return {
		orgId,
		query: <T>(pipe: string, params: Record<string, unknown>, _options?: SqlQueryOptions) =>
			Effect.tryPromise({
				try: async (): Promise<{ data: ReadonlyArray<T> }> => {
					const started = performance.now()
					try {
						const res = await fetch(endpoint, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${token}`,
							},
							body: JSON.stringify({ pipe, params }),
						})
						if (!res.ok) {
							const text = await res.text().catch(() => "")
							throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`)
						}
						const json = (await res.json()) as { data?: ReadonlyArray<T> }
						return { data: json.data ?? [] }
					} finally {
						// Server-side SQL isn't returned; log the pipe + params instead.
						debugLog(
							`${pipe} · ${Math.round(performance.now() - started)}ms`,
							JSON.stringify(params),
						)
					}
				},
				catch: (error) =>
					new WarehouseQueryError({
						message: error instanceof Error ? error.message : String(error),
						pipeName: pipe,
					}),
			}).pipe(
				Effect.tap((result) => Effect.annotateCurrentSpan({ "result.rowCount": result.data.length })),
				Effect.withSpan("warehouse.query", {
					kind: "client",
					attributes: {
						"peer.service": "maple-api",
						"db.system.name": "clickhouse",
						"query.context": pipe,
					},
				}),
			),
		sqlQuery: <T = Record<string, unknown>>(_sql: string, _options?: SqlQueryOptions) =>
			Effect.fail(
				new WarehouseClientError({ message: RAW_SQL_REMOTE_MESSAGE, pipeName: "sqlQuery" }),
			) as Effect.Effect<ReadonlyArray<T>, WarehouseClientError>,
		compiledQuery: <T>(_compiled: unknown, _options?: SqlQueryOptions) =>
			Effect.fail(
				new WarehouseClientError({ message: RAW_SQL_REMOTE_MESSAGE, pipeName: "compiledQuery" }),
			) as Effect.Effect<ReadonlyArray<T>, WarehouseClientError>,
		compiledQueryFirst: <T>(_compiled: unknown, _options?: SqlQueryOptions) =>
			Effect.fail(
				new WarehouseClientError({ message: RAW_SQL_REMOTE_MESSAGE, pipeName: "compiledQueryFirst" }),
			) as Effect.Effect<Option.Option<T>, WarehouseClientError>,
	}
}
