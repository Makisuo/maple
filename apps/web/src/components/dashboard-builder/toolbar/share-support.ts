/**
 * Which widgets a shared view can actually render.
 *
 * A share builds every query on the server, from a closed allowlist of data
 * sources. Anything outside it is refused at fetch time and drawn as a muted
 * "not available in shared views" tile — correct, but a nasty surprise if the
 * first time you learn it is after sending someone the link. This is the same
 * judgement made ahead of time, so the dialog can say so before you share.
 *
 * Mirrors `ROUTE_ENDPOINT_PLANS` in
 * `apps/api/src/services/dashboards/route-endpoint-plans.ts`. Kept as a plain
 * list rather than imported, because that module pulls in the query registry
 * and the warehouse services — none of which belong in the browser bundle. A
 * drift here is cosmetic in one direction (a warning for a widget that would
 * have worked) and a missing warning in the other; the server remains the
 * authority either way.
 */

/** Route endpoints the share resolver can serve. */
const SUPPORTED_ROUTE_ENDPOINTS = new Set([
	"errors_by_type",
	"errors_summary",
	"service_overview",
	"service_usage",
	"list_logs",
])

/** Prose for the dialog, so the copy and the list cannot disagree. */
export const SHAREABLE_WIDGET_KINDS =
	"query-builder charts, raw SQL, markdown, and errors, service and logs tiles"

interface WidgetLike {
	readonly id: string
	readonly display?: { readonly title?: string }
	readonly dataSource?: unknown
}

const isSupported = (dataSource: unknown): boolean => {
	if (dataSource === null || typeof dataSource !== "object") return false
	const source = dataSource as { kind?: string; endpoint?: string }

	// v3 kinds the server builds queries for directly.
	if (source.kind === "query" || source.kind === "raw_sql" || source.kind === "static") return true

	// A route source — v3 `kind: "route"` or a legacy v2 `{ endpoint }` with no
	// kind at all — is supported only if its endpoint is on the allowlist.
	const endpoint = source.endpoint
	if (typeof endpoint === "string") return SUPPORTED_ROUTE_ENDPOINTS.has(endpoint)

	// A `kind: "route"` with no endpoint cannot resolve to anything.
	return false
}

export interface UnsupportedShareWidget {
	readonly id: string
	readonly title: string
}

/** Widgets that will render as unavailable tiles for a viewer. */
export function unsupportedShareWidgets(
	widgets: ReadonlyArray<WidgetLike>,
): ReadonlyArray<UnsupportedShareWidget> {
	return widgets
		.filter((widget) => !isSupported(widget.dataSource))
		.map((widget) => ({ id: widget.id, title: widget.display?.title ?? widget.id }))
}
