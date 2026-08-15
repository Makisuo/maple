/**
 * Data for a shared dashboard, fetched through the public share API.
 *
 * A share page cannot use `useWidgetData`. That hook's first move is
 * `toWidgetRequest(dataSource)` — turning a stored data source into an endpoint
 * and params to send — and a share's document has neither by design: the
 * redaction seam strips them precisely so a viewer cannot learn what is being
 * queried. The server holds the real data source and builds the query itself.
 *
 * So the request shape differs (a widget id, not a query) while everything
 * downstream is identical. This hook produces the same `WidgetDataState` union
 * the authed path does, which is what lets the share page render through the
 * unmodified visualization components rather than a parallel set of charts.
 *
 * What is deliberately *absent* here, compared to `useWidgetData`: the list-cap
 * guard, variable-reference gating, and range validation. All three moved
 * server-side for shares, because a viewer's client is not trusted to enforce
 * them — re-implementing them here would be duplicated logic whose only effect
 * is to fail slightly earlier.
 */
import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

export interface ShareTimeRange {
	readonly startTime: string
	readonly endTime: string
}

export interface SharedDashboardDocument {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly timeRange: unknown
	readonly widgets: ReadonlyArray<{
		readonly id: string
		readonly visualization: string
		readonly display: Record<string, unknown>
		readonly layout: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
		readonly dataSource: { readonly kind: string; readonly transform?: unknown }
	}>
	readonly variables?: ReadonlyArray<{
		readonly name: string
		readonly type: string
		readonly label?: string
		readonly options?: ReadonlyArray<{ readonly value: string; readonly label?: string }>
		readonly defaultValue?: string
		readonly includeAll?: boolean
	}>
}

export interface SharedDashboard {
	readonly mode: "public" | "org"
	readonly scope: "dashboard" | "widget"
	readonly dashboard: SharedDashboardDocument
	readonly limits: { readonly maxRangeSeconds: number; readonly maxListRangeSeconds: number }
	readonly embeddable: boolean
}

/** Why a share failed to open, as the page needs to distinguish it. */
export type ShareResolveError =
	| { readonly kind: "not_found" }
	| { readonly kind: "signin_required" }
	| { readonly kind: "wrong_org" }
	| { readonly kind: "rate_limited" }
	| { readonly kind: "unavailable"; readonly message: string }

/**
 * A share request, with the viewer's session attached only if they have one.
 *
 * Maple authenticates with a bearer token, not a cookie, so `credentials:
 * "include"` is both wrong and actively harmful here — it is incompatible with
 * the API's wildcard CORS origin and makes the request fail outright.
 *
 * `signedIn` gates the token lookup rather than always attempting it: an
 * anonymous viewer has no Clerk session to ask, and calling for one would throw
 * on the very path that must work without an account.
 */
const post = async (path: string, body: unknown, signedIn: boolean): Promise<Response> => {
	const authHeaders = signedIn ? await getMapleAuthHeaders().catch(() => ({})) : {}
	return fetch(`${apiBaseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...authHeaders },
		body: JSON.stringify(body),
	})
}

const toResolveError = (status: number, payload: unknown): ShareResolveError => {
	const tag = (payload as { _tag?: string } | null)?._tag
	const reason = (payload as { reason?: string } | null)?.reason

	if (tag === "@maple/http/errors/ShareForbiddenError") {
		return reason === "wrong_org" ? { kind: "wrong_org" } : { kind: "signin_required" }
	}
	if (tag === "@maple/http/errors/ShareRateLimitedError") return { kind: "rate_limited" }
	// Every "this link does not resolve" reason arrives as the same 404 by
	// design, so the page has exactly one state for it too.
	if (status === 404) return { kind: "not_found" }
	return {
		kind: "unavailable",
		message: (payload as { message?: string } | null)?.message ?? "This dashboard could not be loaded.",
	}
}

export function useSharedDashboard(token: string, isSignedIn: boolean) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "ready"; share: SharedDashboard }
		| { status: "error"; error: ShareResolveError }
	>({ status: "loading" })

	useEffect(() => {
		let cancelled = false
		setState({ status: "loading" })
		post("/api/share/resolve", { token }, isSignedIn)
			.then(async (response) => {
				const payload = await response.json().catch(() => null)
				if (cancelled) return
				if (!response.ok) {
					setState({ status: "error", error: toResolveError(response.status, payload) })
					return
				}
				setState({ status: "ready", share: payload as SharedDashboard })
			})
			.catch(() => {
				if (!cancelled) {
					setState({
						status: "error",
						error: { kind: "unavailable", message: "This dashboard could not be loaded." },
					})
				}
			})
		return () => {
			cancelled = true
		}
		// `isSignedIn` is a dependency, not a stray: an org-only link opened before
		// Clerk settles resolves as `signin_required`, and must retry itself once
		// the session lands rather than stranding a signed-in member on a
		// "sign in to view" card.
	}, [token, isSignedIn])

	return state
}

interface WidgetDataResult {
	readonly states: Readonly<Record<string, WidgetDataState>>
	readonly narrowed: Readonly<Record<string, number>>
	readonly refresh: () => void
}

/** Matches the server's per-request cap, so a batch is never rejected wholesale. */
const BATCH_MAX = 4

/**
 * Fetch data for every widget on a share, in server-sized batches.
 *
 * Batches sequentially rather than all at once: a shared board is served to an
 * audience the org does not control, and issuing every batch in parallel would
 * let one page load fan out across the rate limit that protects it.
 */
export function useShareWidgetData(
	token: string,
	widgetIds: ReadonlyArray<string>,
	timeRange: ShareTimeRange,
	variableValues: Readonly<Record<string, string>>,
	enabled: boolean,
	signedIn: boolean,
): WidgetDataResult {
	const [states, setStates] = useState<Record<string, WidgetDataState>>({})
	const [narrowed, setNarrowed] = useState<Record<string, number>>({})
	const [nonce, setNonce] = useState(0)
	const refresh = useCallback(() => setNonce((value) => value + 1), [])

	// Stringified so the effect keys on value rather than array identity, which
	// changes on every render of the parent.
	const idsKey = useMemo(() => widgetIds.join(","), [widgetIds])
	const variablesKey = useMemo(() => JSON.stringify(variableValues), [variableValues])
	const latestRequest = useRef(0)

	useEffect(() => {
		if (!enabled || widgetIds.length === 0) return
		const requestId = ++latestRequest.current
		let cancelled = false

		const ids = idsKey.split(",").filter(Boolean)
		setStates((current) => {
			const next: Record<string, WidgetDataState> = { ...current }
			for (const id of ids) next[id] ??= { status: "loading" }
			return next
		})

		const run = async () => {
			for (let index = 0; index < ids.length; index += BATCH_MAX) {
				const batch = ids.slice(index, index + BATCH_MAX)
				try {
					const response = await post(
						"/api/share/widget-data",
						{
							token,
							requests: batch.map((widgetId) => ({ widgetId })),
							timeRange,
							variableValues: JSON.parse(variablesKey) as Record<string, string>,
						},
						signedIn,
					)
					const payload = await response.json().catch(() => null)
					// A stale batch must never overwrite a newer one's results — the
					// viewer may have moved the time picker mid-flight.
					if (cancelled || requestId !== latestRequest.current) return

					if (!response.ok) {
						const message =
							(payload as { message?: string } | null)?.message ??
							"This data could not be loaded."
						setStates((current) => {
							const next = { ...current }
							for (const id of batch) next[id] = { status: "error", message }
							return next
						})
						continue
					}

					const results = (payload as { results?: ReadonlyArray<Record<string, unknown>> })?.results
					setStates((current) => {
						const next = { ...current }
						for (const result of results ?? []) {
							const id = result.widgetId as string
							next[id] =
								result.ok === true
									? { status: "ready", data: result.data }
									: {
											status: "error",
											message: (result.message as string) ?? "Unavailable",
											// An unsupported widget is an expected state, not a
											// failure: the tile renders muted, not red.
											kind: result.reason === "unsupported" ? "range" : "runtime",
										}
						}
						return next
					})
					setNarrowed((current) => {
						const next = { ...current }
						for (const result of results ?? []) {
							if (typeof result.narrowedToSeconds === "number") {
								next[result.widgetId as string] = result.narrowedToSeconds
							}
						}
						return next
					})
				} catch {
					if (cancelled || requestId !== latestRequest.current) return
					setStates((current) => {
						const next = { ...current }
						for (const id of batch) {
							next[id] = { status: "error", message: "This data could not be loaded." }
						}
						return next
					})
				}
			}
		}

		void run()
		return () => {
			cancelled = true
		}
	}, [token, idsKey, timeRange, variablesKey, enabled, nonce, signedIn, widgetIds.length])

	return { states, narrowed, refresh }
}
