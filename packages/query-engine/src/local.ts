// Shared client for the local Maple server's `POST /local/query` endpoint, used
// by both the browser SPA (`apps/local-ui`) and the query CLI (`apps/cli`).
// The endpoint runs raw SQL through the in-process chDB session and returns a
// bare JSON array.
//
// The output FORMAT is owned by the server: `forceJsonEachRow` in
// `apps/cli/src/server/serve.ts` strips whatever trailing `FORMAT <fmt>` the
// compiler emitted (`CH.compile(...)` appends `FORMAT JSON`) and re-runs the
// query as `FORMAT JSONEachRow`. So callers POST `compiled.sql` verbatim.

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
export class LocalQueryHttpError extends Error {
	readonly name = "LocalQueryHttpError"

	constructor(
		readonly status: number,
		readonly statusText: string,
		readonly location: string | null,
		readonly detail: string,
	) {
		super(`Local query failed (${status} ${statusText})${detail ? `: ${detail}` : ""}`)
	}
}

export async function executeLocalQuery<T = Record<string, unknown>>(
	sql: string,
	baseUrl = "",
	signal?: AbortSignal,
	headers: Record<string, string> = {},
): Promise<T[]> {
	const res = await fetch(`${baseUrl}/local/query`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ sql }),
		signal,
		redirect: "manual",
	})

	if (!res.ok) {
		const detail = await res.text().catch(() => "")
		throw new LocalQueryHttpError(res.status, res.statusText, res.headers.get("location"), detail)
	}

	const json = (await res.json()) as unknown
	if (!Array.isArray(json)) {
		throw new Error("Local query response was not a JSON array")
	}
	return json as T[]
}
