import { Schema } from "effect"
import { DashboardRefreshIntervalSeconds } from "@maple/domain/http"

// Cross-widget dashboard controls live in the URL so a view is shareable and
// deep-linkable. Two families share that space:
//
//   `var-<name>`  dashboard-variable selections (Grafana-style)
//   `filter`, `collapsed`, `expanded`, `tab`, `widget`, `refresh`
//                 per-viewer view state: the free-text filter clause, section
//                 collapse overrides, the active tab per section, a tile
//                 deep link, and the auto-refresh cadence
//
// This module is the one owner of both. Every `navigate()` on a dashboard route
// rebuilds search from `pickDashboardControlParams`, so a param that is not
// listed here is silently dropped the next time the user toggles edit mode or
// changes a variable. Adding a control param means adding it here first.
export const VARIABLE_PARAM_PREFIX = "var-"

export type VariableSearchParams = Record<`${typeof VARIABLE_PARAM_PREFIX}${string}`, unknown>

/**
 * Schema fragment that retains `var-*` keys on a route's search. Values are
 * `Unknown` on purpose: TanStack JSON-parses each search value, and a
 * hand-edited URL must never crash the route — non-strings are coerced or
 * ignored when read.
 */
export const variableSearchRest = Schema.Record(
	Schema.TemplateLiteral([VARIABLE_PARAM_PREFIX, Schema.String]),
	Schema.Unknown,
)

/**
 * Per-viewer view state. `Schema.optional` rather than `optionalKey` because
 * these are search params, where `undefined` is a real JS value.
 *
 * All of them are flat scalars rather than JSON blobs: these end up in URLs
 * people paste to each other, and a hand-editable `?tab=overview:latency` is
 * both readable and impossible to fail parsing.
 */
export const dashboardViewParamsSchema = {
	/** Free-text dashboard filter clause, in the `@maple/domain` where-clause grammar. */
	filter: Schema.optional(Schema.String),
	/** Comma-joined section ids forced collapsed, overriding each section's stored default. */
	collapsed: Schema.optional(Schema.String),
	/** Comma-joined section ids forced expanded. Wins over `collapsed`. */
	expanded: Schema.optional(Schema.String),
	/** Comma-joined `sectionId:tabId` pairs. An absent section falls back to its first tab. */
	tab: Schema.optional(Schema.String),
	/** Widget deep link: expand the owning section, switch to its tab, scroll to it, flash it. */
	widget: Schema.optional(Schema.String),
	/**
	 * Auto-refresh cadence in seconds, overriding the dashboard's saved default
	 * for this viewer only. `0` is a real value meaning "explicitly off", so a
	 * viewer can silence a board that auto-refreshes for everyone else.
	 *
	 * The only numeric control param: written as a number so the URL reads
	 * `?refresh=30` rather than the `?refresh="30"` TanStack emits to preserve
	 * string-ness. The string arm keeps a hand-edited quoted form working, and
	 * anything unparseable falls back rather than failing the route.
	 */
	refresh: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
}

export interface DashboardViewParams {
	filter?: string
	collapsed?: string
	expanded?: string
	tab?: string
	widget?: string
	refresh?: number | string
}

export type DashboardControlParams = VariableSearchParams & DashboardViewParams

/**
 * The `var-*` params of a decoded search, prefix stripped and coerced to
 * strings — TanStack JSON-parses values, so `?var-port=8080` arrives as a
 * number. Shared by the dashboard route and the share page, so a `var-` deep
 * link means the same thing on both.
 */
export function variableValuesFromSearch(search: Record<string, unknown>): Record<string, string> {
	const values: Record<string, string> = {}
	for (const [key, value] of Object.entries(search)) {
		if (!key.startsWith(VARIABLE_PARAM_PREFIX)) continue
		if (typeof value === "string") {
			values[key.slice(VARIABLE_PARAM_PREFIX.length)] = value
		} else if (typeof value === "number" || typeof value === "boolean") {
			values[key.slice(VARIABLE_PARAM_PREFIX.length)] = String(value)
		}
	}
	return values
}

const VIEW_PARAM_KEYS = ["filter", "collapsed", "expanded", "tab", "widget", "refresh"] as const

/** Ordered cadence options for the picker, straight off the schema's closed set. */
export const REFRESH_INTERVAL_OPTIONS: ReadonlyArray<DashboardRefreshIntervalSeconds> =
	DashboardRefreshIntervalSeconds.literals

const REFRESH_INTERVAL_VALUES = new Set<number>(REFRESH_INTERVAL_OPTIONS)

/** A cadence if the value is a member of the closed set, `undefined` otherwise. */
export function parseRefreshIntervalSeconds(value: unknown): DashboardRefreshIntervalSeconds | undefined {
	// TanStack JSON-parses search values, so `?refresh=30` can arrive as either a
	// number or a string depending on how it was written. An empty `?refresh=` is
	// treated as absent rather than as `Number("") === 0`, which would silently
	// read a truncated URL as "auto-refresh off".
	const seconds =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN
	return REFRESH_INTERVAL_VALUES.has(seconds) ? (seconds as DashboardRefreshIntervalSeconds) : undefined
}

/**
 * The cadence this viewer should actually poll at: `?refresh=` wins, then the
 * dashboard's saved default, then off.
 *
 * A hand-edited `?refresh=1` or `?refresh=abc` falls back rather than throwing —
 * same posture as the non-string view params above, and the reason the closed
 * literal set exists at all (nobody gets to ask for a 100ms re-query).
 */
export function resolveRefreshIntervalSeconds(
	param: unknown,
	stored: number | undefined,
): DashboardRefreshIntervalSeconds {
	return parseRefreshIntervalSeconds(param) ?? parseRefreshIntervalSeconds(stored) ?? 0
}

/**
 * Pick every cross-widget control param out of an arbitrary search object.
 *
 * Deliberately excludes `mode`: edit mode is set explicitly by the caller that
 * wants it, so folding it in here would make every navigation sticky in edit.
 *
 * Non-string view params are dropped rather than coerced — `?collapsed=5` is a
 * hand-edit typo, and silently reading it as the section id "5" is worse than
 * ignoring it. `var-*` values keep the looser `unknown` handling they already
 * had, because the variables context coerces them at read time.
 */
export function pickDashboardControlParams(search: Record<string, unknown>): DashboardControlParams {
	const params: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(search)) {
		if (key.startsWith(VARIABLE_PARAM_PREFIX)) {
			params[key] = value
		}
	}

	for (const key of VIEW_PARAM_KEYS) {
		const value = search[key]
		if (typeof value === "string") {
			params[key] = value
		}
	}

	// `refresh` is the one numeric control param (`?refresh=30`), so the
	// string-only loop above would drop it. An out-of-set number survives the
	// pick and is rejected later by `resolveRefreshIntervalSeconds`, which keeps
	// this function's job to "carry the control params forward".
	if (typeof search.refresh === "number") params.refresh = search.refresh

	return params
}
