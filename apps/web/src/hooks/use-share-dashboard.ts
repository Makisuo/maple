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
import { ShareWidgetDataResponse } from "@maple/domain/http"
import { DashboardSectionSchema, TimeRangeSchema, WidgetLayoutSchema } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const decodeShareWidgetDataResponse = Schema.decodeUnknownPromise(ShareWidgetDataResponse)
const decodeVariableValues = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))

export interface ShareTimeRange {
	readonly startTime: string
	readonly endTime: string
}

/**
 * A widget as a share publishes it.
 *
 * Decoded rather than asserted, because the page now *lays out* from this
 * payload: `layout`, `sectionId` and `tabId` decide where a tile lands, so a
 * field arriving in the wrong shape has to fail here rather than silently
 * collapse the board into a flat grid.
 *
 * `WidgetLayoutSchema` and `TimeRangeSchema` are the same schemas the stored
 * document uses — reusing them is what makes this an adapter and not a cast:
 * the decoded `layout` *is* the canvas's `PlacedWidget["layout"]`.
 */
const ShareWidgetSchema = Schema.Struct({
	id: Schema.String,
	// Deliberately a plain string, not the closed `WidgetVisualization` union:
	// an older client reading a newer board must still render. `widgetTypeFor`
	// is the one place that decides what an unknown type draws as, and it
	// already warns and falls back.
	visualization: Schema.String,
	// Left loose on purpose. The display config's real schema is parameterised
	// on a data source (`display.sparkline` embeds a whole one), and a share's
	// data source is redacted — so decoding it strictly here would assert a
	// shape the share transport does not promise. Passed through to the
	// visualization exactly as before.
	display: Schema.Record(Schema.String, Schema.Unknown),
	layout: WidgetLayoutSchema,
	sectionId: Schema.optionalKey(Schema.String),
	tabId: Schema.optionalKey(Schema.String),
	timeRange: Schema.optionalKey(TimeRangeSchema),
	dataSource: Schema.Struct({
		kind: Schema.String,
		resultShape: Schema.optionalKey(Schema.String),
		transform: Schema.optionalKey(Schema.Unknown),
	}),
})

export type ShareWidget = typeof ShareWidgetSchema.Type

/**
 * `sections` decodes separately from the rest of the document, and failure
 * degrades to an ungrouped board rather than a dead page: `redactForShare`
 * passes stored sections through verbatim, so an older stored shape should cost
 * the grouping, not the dashboard.
 */
const ShareSectionsSchema = Schema.Array(DashboardSectionSchema)

const SharedDashboardDocumentSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	timeRange: Schema.Unknown,
	widgets: Schema.Array(ShareWidgetSchema),
	// Decoded leniently here, then narrowed below — see `ShareSectionsSchema`.
	sections: Schema.optionalKey(Schema.Unknown),
	variables: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	refreshIntervalSeconds: Schema.optionalKey(Schema.Number),
})

const SharedDashboardResponseSchema = Schema.Struct({
	mode: Schema.Literals(["public", "org"]),
	scope: Schema.Literals(["dashboard", "widget"]),
	dashboard: SharedDashboardDocumentSchema,
	limits: Schema.Struct({
		maxRangeSeconds: Schema.Number,
		maxListRangeSeconds: Schema.Number,
	}),
	embeddable: Schema.Boolean,
})

export type SharedDashboardDocument = typeof SharedDashboardDocumentSchema.Type

export interface SharedDashboard extends Omit<typeof SharedDashboardResponseSchema.Type, "dashboard"> {
	readonly dashboard: SharedDashboardDocument & {
		readonly sections: ReadonlyArray<typeof DashboardSectionSchema.Type>
	}
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

	if (tag === "@maple/http/errors/ShareSignInRequiredError") return { kind: "signin_required" }
	if (tag === "@maple/http/errors/ShareWrongOrgError") return { kind: "wrong_org" }
	if (tag === "@maple/http/errors/ShareRateLimitedError") return { kind: "rate_limited" }
	// Every "this link does not resolve" reason arrives as the same 404 by
	// design, so the page has exactly one state for it too.
	if (status === 404) return { kind: "not_found" }
	return {
		kind: "unavailable",
		message: (payload as { message?: string } | null)?.message ?? "This dashboard could not be loaded.",
	}
}

const decodeSharedDashboard = Schema.decodeUnknownPromise(SharedDashboardResponseSchema)
const decodeShareSections = Schema.decodeUnknownSync(ShareSectionsSchema)

/**
 * Decode a resolve payload, keeping a board whose groups fail to decode.
 *
 * The tiles are the dashboard; the grouping is how they are arranged. A stored
 * section shape this build doesn't recognise should drop the grouping and
 * render an ungrouped board, never blank the page.
 */
export const decodeShare = async (payload: unknown): Promise<SharedDashboard> => {
	const decoded = await decodeSharedDashboard(payload)
	let sections: ReadonlyArray<typeof DashboardSectionSchema.Type> = []
	if (decoded.dashboard.sections !== undefined) {
		try {
			sections = decodeShareSections(decoded.dashboard.sections)
		} catch {
			console.warn("[share] dashboard sections could not be decoded — rendering ungrouped")
		}
	}
	return { ...decoded, dashboard: { ...decoded.dashboard, sections } }
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
		post("/v2/share/resolve", { token }, isSignedIn)
			.then(async (response) => {
				const payload = await response.json().catch(() => null)
				if (cancelled) return
				if (!response.ok) {
					setState({ status: "error", error: toResolveError(response.status, payload) })
					return
				}
				// A payload that fails to decode lands in the same "unavailable" state
				// a 5xx does, via the `.catch` below — the page must not throw
				// through the route on a malformed body.
				const share = await decodeShare(payload)
				if (cancelled) return
				setState({ status: "ready", share })
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

	// react-doctor-disable-next-line react-doctor/no-fetch-in-effect, react-doctor/no-set-state-after-await-in-effect -- Public share data follows effect dependencies and guards every async update with cancellation and request identity.
	useEffect(() => {
		if (!enabled || widgetIds.length === 0) return
		const requestId = ++latestRequest.current
		let cancelled = false

		const ids = idsKey.split(",").filter(Boolean)
		setStates((current) => {
			const next = { ...current }
			for (const id of ids) next[id] ??= { status: "loading" }
			return next
		})

		const run = async () => {
			for (let index = 0; index < ids.length; index += BATCH_MAX) {
				const batch = ids.slice(index, index + BATCH_MAX)
				try {
					// react-doctor-disable-next-line react-doctor/async-await-in-loop -- Sequential batches enforce the anonymous-viewer rate limit and prevent one page load from fanning out.
					const response = await post(
						"/v2/share/widget-data",
						{
							token,
							requests: batch.map((widgetId) => ({ widgetId })),
							timeRange,
							variableValues: decodeVariableValues(JSON.parse(variablesKey)),
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

					const { results } = await decodeShareWidgetDataResponse(payload)
					setStates((current) => {
						const next = { ...current }
						for (const result of results) {
							const id = result.widgetId
							next[id] =
								result.ok === true
									? { status: "ready", data: result.data }
									: {
											status: "error",
											message: result.message,
											// An unsupported widget is an expected state, not a
											// failure: the tile renders muted, not red.
											kind: result.reason === "unsupported" ? "range" : "runtime",
										}
						}
						return next
					})
					setNarrowed((current) => {
						const next = { ...current }
						for (const result of results) {
							if (result.ok && result.narrowedToSeconds !== undefined) {
								next[result.widgetId] = result.narrowedToSeconds
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
