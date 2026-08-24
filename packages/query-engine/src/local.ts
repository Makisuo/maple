// Shared client for the local Maple server's `POST /local/query` endpoint, used
// by both the browser SPA (`apps/local-ui`) and the query CLI (`apps/cli`).
// The endpoint runs raw SQL through the in-process chDB session and returns a
// bare JSON array.
//
// The output FORMAT is owned by the server: `forceJsonEachRow` in
// `apps/cli/src/server/serve.ts` strips whatever trailing `FORMAT <fmt>` the
// compiler emitted (`CH.compile(...)` appends `FORMAT JSON`) and re-runs the
// query as `FORMAT JSONEachRow`. So callers POST `compiled.sql` verbatim.

import { Schema } from "effect"

/**
 * The local server refused the query. Its own tag, and structured fields, so
 * callers stop re-deriving the cause from the rendered sentence: `status` is
 * the HTTP status, `detail` the server's body, and `code`/`type` the chDB error
 * identity lifted out of it (`60` / `UNKNOWN_TABLE`).
 */
export class LocalQueryFailed extends Schema.TaggedError<LocalQueryFailed>()(
	"@maple/query-engine/LocalQueryFailed",
	{
		status: Schema.Number,
		detail: Schema.String,
		code: Schema.optionalKey(Schema.String),
		type: Schema.optionalKey(Schema.String),
		message: Schema.String,
	},
) {}

/** The server answered 2xx with something that was not the documented JSON array. */
export class LocalQueryMalformedResponse extends Schema.TaggedError<LocalQueryMalformedResponse>()(
	"@maple/query-engine/LocalQueryMalformedResponse",
	{ message: Schema.String },
) {}

/**
 * Execute compiled SQL against the local Maple binary and return the rows.
 *
 * @param sql      The compiled SQL (e.g. from `CH.compile(...).sql`), sent as-is.
 * @param baseUrl  Origin of the local binary. Defaults to `""` (a relative
 *                 `/local/query`, for the SPA behind its vite proxy); the CLI
 *                 passes an absolute address like `http://127.0.0.1:4318`.
 * @param signal   Optional `AbortSignal` to cancel the request — used by the
 *                 SPA's connection probe (`AbortSignal.timeout(...)`) so a server
 *                 that accepts the connection but hangs surfaces as an error
 *                 instead of pending forever. Heavy list queries pass nothing.
 */
export async function executeLocalQuery<T = Record<string, unknown>>(
	sql: string,
	baseUrl = "",
	signal?: AbortSignal,
): Promise<T[]> {
	const res = await fetch(`${baseUrl}/local/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql }),
		signal,
	})

	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).trim()
		throw new LocalQueryFailed({
			status: res.status,
			detail,
			// `code`/`type` are the fields `mapWarehouseError` reads off a thrown
			// error to classify it. Parsing them here is what lets the classifier
			// see `UNKNOWN_TABLE` instead of regex-matching the rendered sentence.
			...clickHouseErrorFields(detail),
			message: `Local query failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
		})
	}

	const json = (await res.json()) as unknown
	if (!Array.isArray(json)) {
		throw new LocalQueryMalformedResponse({
			message: "Local query response was not a JSON array",
		})
	}
	return json as T[]
}

/**
 * chDB renders its failures as `query failed: Code: 60. DB::Exception: … (UNKNOWN_TABLE)`.
 * Lift the numeric code and the symbolic type out of that text so the error
 * carries them as fields.
 *
 * They are read by `mapWarehouseError`, which classifies on `error.code` /
 * `error.type` first and falls back to matching the message. Without them every
 * local-mode failure had to be recognised from its prose, which is why the same
 * `Local query failed (400 …)` surfaced as three different tags depending on
 * which regex happened to fire.
 */
const clickHouseErrorFields = (
	detail: string,
): { readonly code?: string; readonly type?: string } => {
	const code = detail.match(/\bCode:\s*(\d+)/)?.[1]
	// The type is the trailing parenthesised SCREAMING_CASE token; chDB puts it
	// last, after the human sentence.
	const type = detail.match(/\(([A-Z][A-Z0-9_]{2,})\)\s*$/)?.[1]
	return { ...(code === undefined ? {} : { code }), ...(type === undefined ? {} : { type }) }
}
