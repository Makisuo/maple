import { Duration, Effect, Option, Schema, type Option as EffectOption } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { type WarehouseExecutorShape, type SqlQueryOptions } from "@maple/query-engine/observability"
import {
	type WarehouseError,
	WarehouseClientError,
	WarehouseQueryError,
	warehouseHttpErrors,
} from "@maple/domain/http/warehouse-errors"
import { debugLog } from "../lib/debug"

const RAW_SQL_REMOTE_MESSAGE =
	"Raw SQL (`maple query`) is only available in local mode. In remote mode, use the typed commands (services, traces, errors, logs, timeseries, …)."

const WarehouseErrorSchema = Schema.Union([...warehouseHttpErrors])
const WarehouseErrorEnvelope = Schema.Struct({ error: WarehouseErrorSchema })
const decodeWarehouseErrorJson = Schema.decodeUnknownOption(Schema.fromJsonString(WarehouseErrorSchema))
const decodeWarehouseErrorEnvelopeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(WarehouseErrorEnvelope),
)
const RemoteQueryResponse = Schema.Struct({ data: Schema.optionalKey(Schema.Array(Schema.Unknown)) })
const decodeRemoteQueryResponseJson = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteQueryResponse))

const decodeRemoteWarehouseError = (text: string): WarehouseError | undefined => {
	const direct = decodeWarehouseErrorJson(text)
	if (Option.isSome(direct)) return direct.value
	const envelope = decodeWarehouseErrorEnvelopeJson(text)
	return Option.isSome(envelope) ? envelope.value.error : undefined
}

const unsupported = <A>(pipeName: string): Effect.Effect<A, WarehouseClientError> =>
	Effect.fail(new WarehouseClientError({ message: RAW_SQL_REMOTE_MESSAGE, pipeName }))

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
	client: HttpClient.HttpClient,
	apiUrl: string,
	token: string,
	orgId: string,
): WarehouseExecutorShape => {
	const endpoint = `${apiUrl.replace(/\/$/, "")}/api/tinybird/query`
	const serverAddress = new URL(endpoint).hostname
	return {
		orgId,
		query: <T>(pipe: string, params: Record<string, unknown>, options?: SqlQueryOptions) =>
			Effect.gen(function* () {
				const started = performance.now()
				const request = HttpClientRequest.post(endpoint, {
					headers: { authorization: `Bearer ${token}` },
				}).pipe(HttpClientRequest.bodyText(JSON.stringify({ pipe, params }), "application/json"))
				return yield* Effect.gen(function* () {
					const response = yield* client
						.execute(request)
						.pipe(
							Effect.mapError(
								(error) =>
									new WarehouseQueryError({
										message: error.message,
										pipeName: pipe,
										cause: error,
									}),
							),
						)
					const text = yield* response.text.pipe(
						Effect.mapError(
							(error) =>
								new WarehouseQueryError({
									message: error.message,
									pipeName: pipe,
									cause: error,
								}),
						),
					)
					if (response.status < 200 || response.status >= 300) {
						const decoded = decodeRemoteWarehouseError(text)
						if (decoded !== undefined) return yield* decoded
						return yield* new WarehouseQueryError({
							message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
							pipeName: pipe,
							cause: text,
						})
					}
					const json = yield* Effect.try({
						try: () => decodeRemoteQueryResponseJson(text),
						catch: (error) =>
							new WarehouseQueryError({
								message: error instanceof Error ? error.message : String(error),
								pipeName: pipe,
								cause: error,
							}),
					})
					return { data: (json.data ?? []) as ReadonlyArray<T> }
				}).pipe(
					Effect.timeoutOrElse({
						duration: Duration.minutes(2),
						orElse: () =>
							Effect.fail(
								new WarehouseQueryError({
									message: "Remote warehouse query timed out after 2 minutes",
									pipeName: pipe,
									cause: "timeout",
								}),
							),
					}),
					Effect.ensuring(
						Effect.sync(() =>
							debugLog(
								`${pipe} · ${Math.round(performance.now() - started)}ms`,
								JSON.stringify(params),
							),
						),
					),
				)
			}).pipe(
				Effect.tap((result) => Effect.annotateCurrentSpan({ "result.rowCount": result.data.length })),
				Effect.withSpan("warehouse.query", {
					kind: "client",
					attributes: {
						"peer.service": "maple-api",
						"http.request.method": "POST",
						"url.full": endpoint,
						"server.address": serverAddress,
						"query.context": options?.context ?? pipe,
						"query.profile": options?.profile,
					},
				}),
			),
		sqlQuery: <T = Record<string, unknown>>(_sql: string, _options?: SqlQueryOptions) =>
			unsupported<ReadonlyArray<T>>("sqlQuery"),
		compiledQuery: <T>(_compiled: unknown, _options?: SqlQueryOptions) =>
			unsupported<ReadonlyArray<T>>("compiledQuery"),
		compiledQueryFirst: <T>(_compiled: unknown, _options?: SqlQueryOptions) =>
			unsupported<EffectOption.Option<T>>("compiledQueryFirst"),
	}
}
