// Product events — funnels over `product_events`.
//
// `product_events` is the one time-sorted table every product event lands in:
// browser page views and `track()` calls via the `session_events` MV, backend
// and mobile events via `POST /v1/events`. Funnels step over it with
// `windowFunnel`, grouped by a per-person key, and every query here keeps the
// page-level filter surface (`ProductEventsFilters`) so the `/analytics`
// sidebar narrows a funnel exactly the way it narrows the page-view panels.
//
// The page-view queries themselves live in `web-analytics.ts` and read the
// same table (`useProductEvents`); this module owns everything funnel-shaped.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import {
	param,
	from,
	fromQuery,
	fromUnion,
	unionAll,
	inSubquery,
	compileFnCall,
} from "@maple-dev/clickhouse-builder"
import type { CHQuery, ColumnAccessor, ColumnDefs, JoinedColumnAccessor } from "@maple-dev/clickhouse-builder"
import { Schema } from "effect"
import { ProductEvents, IdentityLinks, SessionReplays } from "../tables"
import { CHNumber } from "../schema"
import { replaysWhere, needsSessionSemiJoin, type ProductEventsFilters } from "./web-analytics"

export type { ProductEventsFilters } from "./web-analytics"

// Local function helpers (generic per call site, so not `defineFn`)

// arrayElement(arr, i) — 1-based, like ClickHouse.
function arrayElement<T>(arr: CH.Expr<ReadonlyArray<T>>, index: CH.Expr<number>): CH.Expr<T> {
	return compileFnCall<T>("arrayElement", arr, index)
}

// toUInt8(cond) — a condition as a projectable 0/1 column.
function flag(cond: CH.Condition): CH.Expr<number> {
	return compileFnCall<number>("toUInt8", cond)
}

// toUInt64(toUnixTimestamp64Milli(ts)) — `windowFunnel` accepts Date, DateTime
// and unsigned integers but NOT DateTime64, so both branches carry their
// timestamp as epoch milliseconds and the window is `windowSeconds * 1000`.
// Milliseconds rather than `toDateTime()` so two events in the same second
// (page load → track()) keep their real order instead of tying.
function epochMs(ts: CH.Expr<string>): CH.Expr<number> {
	return CH.toUInt64(compileFnCall<number>("toUnixTimestamp64Milli", ts))
}

// argMinIf(value, orderBy, cond) — the `value` on the earliest row matching `cond`.
function argMinIf<T>(value: CH.Expr<T>, orderBy: CH.Expr<unknown>, cond: CH.Condition): CH.Expr<T> {
	return compileFnCall<T>("argMinIf", value, orderBy, cond)
}

// Every UNION ALL branch below is built from a different table, and the shape
// they share is this. `unionAll`'s type unification cannot see through the
// per-branch `select` callbacks (each infers its own literal type), so the
// branches are annotated to it explicitly.
type FunnelEventRow = { readonly [column: string]: unknown }
type FunnelBranch = CHQuery<ColumnDefs, FunnelEventRow, Record<string, ColumnDefs>>

// Public option types

/** Which `session_replays` dimension a `session` step (or a breakdown) reads. */
export type FunnelSessionDimension =
	| "referrerHost"
	| "utmSource"
	| "utmMedium"
	| "utmCampaign"
	| "country"
	| "host"

/**
 * One funnel step.
 *
 * - `event`: a `track()` (or direct-ingested) event by name, optionally
 *   narrowed by `Attributes[k] = v` for every entry of `attributeEquals`.
 * - `page`: a page view of `pagePath` (`Kind = 'navigation'`), optionally on
 *   one `host`.
 * - `session`: "started a session with this acquisition dimension" — the
 *   referral / campaign entry point. Only valid as step 1: it is evaluated
 *   against `session_replays` and enters the funnel as a synthetic
 *   `$session_entry` event at the session's `StartTime`.
 */
export type FunnelStep =
	| {
			readonly kind: "event"
			readonly eventName: string
			readonly attributeEquals?: Readonly<Record<string, string>>
	  }
	| { readonly kind: "page"; readonly pagePath: string; readonly host?: string }
	| { readonly kind: "session"; readonly dimension: FunnelSessionDimension; readonly value: string }

/**
 * What a funnel counts.
 *
 * - `person`: `UserId` when the row carries one, else the `VisitorId`'s linked
 *   user from `identity_links`, else the `VisitorId` — so an anonymous marketing
 *   visit and the same person's post-signup (or server-side) events collapse
 *   into one person.
 * - `visitor` / `user`: the raw column, non-empty.
 * - `session`: `SessionId` — a per-session funnel; server events (no session)
 *   never take part.
 */
export type FunnelKeyBy = "person" | "visitor" | "user" | "session"

export interface ProductEventsFunnelOpts {
	/** 1–10 steps, in order. A `session` step may only appear first. */
	readonly steps: ReadonlyArray<FunnelStep>
	readonly keyBy: FunnelKeyBy
	/** The whole chain must complete within this many seconds of the step-1 event. */
	readonly windowSeconds: number
	/** Sidebar filters — narrow the *population* to persons with a matching session. */
	readonly filters?: ProductEventsFilters
}

/**
 * How a breakdown groups persons: an acquisition dimension of the person's
 * sessions, the event `Host`, or `Attributes[<key>]` on the person's events.
 * In every case the group is the first non-empty value seen for that person.
 */
export type FunnelBreakdownBy = FunnelSessionDimension | `attribute:${string}`

export interface ProductEventsFunnelBreakdownOpts extends ProductEventsFunnelOpts {
	readonly breakdownBy: FunnelBreakdownBy
	/** Groups to keep, ranked by step-1 count. Default 10, max 20. */
	readonly limit?: number
}

export interface ProductEventNamesOpts {
	readonly filters?: ProductEventsFilters
	/** Default 100. */
	readonly limit?: number
}

// Row schemas

export const productEventsFunnelRowSchema = Schema.Struct({
	step: CHNumber,
	count: CHNumber,
})
export type ProductEventsFunnelOutput = typeof productEventsFunnelRowSchema.Type

export const productEventsFunnelBreakdownRowSchema = Schema.Struct({
	group: Schema.String,
	step: CHNumber,
	count: CHNumber,
})
export type ProductEventsFunnelBreakdownOutput = typeof productEventsFunnelBreakdownRowSchema.Type

export const productEventNamesRowSchema = Schema.Struct({
	eventName: Schema.String,
	kind: Schema.String,
	count: CHNumber,
	sessions: CHNumber,
	persons: CHNumber,
})
export type ProductEventNamesOutput = typeof productEventNamesRowSchema.Type

// Validation

/** A funnel definition the builder cannot compile. Thrown, since builders are synchronous. */
export class ProductEventsFunnelError extends Schema.TaggedError<ProductEventsFunnelError>()(
	"@maple/query-engine/ProductEventsFunnelError",
	{
		reason: Schema.Literals([
			"NoSteps",
			"TooManySteps",
			"SessionStepNotFirst",
			"InvalidWindow",
			"InvalidLimit",
		]),
		message: Schema.String,
	},
) {}

export const FUNNEL_MAX_STEPS = 10
export const FUNNEL_BREAKDOWN_MAX_GROUPS = 20

function validate(opts: ProductEventsFunnelOpts): void {
	if (opts.steps.length === 0) {
		throw new ProductEventsFunnelError({ reason: "NoSteps", message: "a funnel needs at least one step" })
	}
	if (opts.steps.length > FUNNEL_MAX_STEPS) {
		throw new ProductEventsFunnelError({
			reason: "TooManySteps",
			message: `a funnel has at most ${FUNNEL_MAX_STEPS} steps, got ${opts.steps.length}`,
		})
	}
	opts.steps.forEach((step, index) => {
		if (step.kind === "session" && index !== 0) {
			throw new ProductEventsFunnelError({
				reason: "SessionStepNotFirst",
				message: `a session step is only valid as step 1, found one at step ${index + 1}`,
			})
		}
	})
	if (!Number.isFinite(opts.windowSeconds) || opts.windowSeconds <= 0) {
		throw new ProductEventsFunnelError({
			reason: "InvalidWindow",
			message: `windowSeconds must be a positive number, got ${String(opts.windowSeconds)}`,
		})
	}
}

// Shared pieces

type EventsAccessor = ColumnAccessor<typeof ProductEvents.columns>
type ReplaysAccessor = ColumnAccessor<typeof SessionReplays.columns>
type IdentityAccessor = {
	readonly SessionId: CH.Expr<string>
	readonly VisitorId: CH.Expr<string>
	readonly UserId: CH.Expr<string>
}
// The `identity_links` join alias — a typed accessor when the join is declared
// statically, an open one under `OpenJoinQuery`.
type LinkAccessor = { readonly UserId: CH.Expr<string | null> } | ColumnAccessor<ColumnDefs>

const LINK_ALIAS = "link"

/**
 * `identity_links` collapsed to one linked user per visitor. ReplacingMergeTree
 * may still hold several rows per (visitor, user) and a visitor may have been
 * linked to more than one user; `argMin(UserId, FirstSeen)` picks the user the
 * visitor became *first*, which is the identity that anonymous rows
 * chronologically precede — the one a conversion funnel wants.
 */
function identityLinksByVisitor() {
	return from(IdentityLinks)
		.select(($) => ({ VisitorId: $.VisitorId, UserId: CH.argMin($.UserId, $.FirstSeen) }))
		.where(($) => [$.OrgId.eq(param.string("orgId"))])
		.groupBy("VisitorId")
}

/** The person key for one row, per {@link FunnelKeyBy}. `link` is set only for `person`. */
function personKey(keyBy: FunnelKeyBy, $: IdentityAccessor, link?: LinkAccessor): CH.Expr<string> {
	switch (keyBy) {
		case "session":
			return $.SessionId
		case "visitor":
			return $.VisitorId
		case "user":
			return $.UserId
		case "person": {
			// join_use_nulls=0 (the default) yields '' for an unmatched LEFT JOIN;
			// coalesce covers a cluster that flips it on and yields NULL instead.
			const linked = link ? compileFnCall<string>("coalesce", link.UserId, CH.lit("")) : CH.lit("")
			return CH.multiIf(
				[
					[$.UserId.neq(""), $.UserId],
					[linked.neq(""), linked],
				],
				$.VisitorId,
			)
		}
	}
}

/** Column of `session_replays` behind a session dimension. */
function sessionDimensionColumn($: ReplaysAccessor, dimension: FunnelSessionDimension): CH.Expr<string> {
	switch (dimension) {
		case "referrerHost":
			return $.ReferrerHost
		case "utmSource":
			return $.UtmSource
		case "utmMedium":
			return $.UtmMedium
		case "utmCampaign":
			return $.UtmCampaign
		case "country":
			return $.Country
		case "host":
			return $.Host
	}
}

/** The step's predicate over a `product_events` row. `session` steps never match an event row. */
function eventStepCondition($: EventsAccessor, step: FunnelStep): CH.Condition | undefined {
	switch (step.kind) {
		case "event": {
			let cond = $.EventName.eq(step.eventName)
			for (const [key, value] of Object.entries(step.attributeEquals ?? {})) {
				cond = cond.and($.Attributes.get(key).eq(value))
			}
			return cond
		}
		case "page": {
			const cond = $.Kind.eq("navigation").and($.PagePath.eq(step.pagePath))
			return step.host === undefined ? cond : cond.and($.Host.eq(step.host))
		}
		case "session":
			return undefined
	}
}

/** True when any sidebar filter is set — i.e. the population must be narrowed. */
function hasPopulationFilter(filters: ProductEventsFilters): boolean {
	return needsSessionSemiJoin(filters) || filters.host !== undefined || filters.pagePath !== undefined
}

/**
 * `SELECT key FROM session_replays WHERE <sidebar filters>` — the persons whose
 * sessions match the filters, under the same key resolution as the events.
 *
 * Person-level rather than `SessionId IN (…)` on purpose: server-side rows have
 * no `SessionId`, so a session semi-join would silently drop every backend
 * step the moment a filter is active. `host` / `pagePath` reach here through
 * `replaysWhere`'s navigation semi-join, which reads `product_events` — funnels
 * require that table anyway.
 */
function matchingPersonsSubquery(keyBy: FunnelKeyBy, filters: ProductEventsFilters) {
	const scoped = { ...filters, useProductEvents: true }
	if (keyBy === "person") {
		return from(SessionReplays, "s")
			.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (s, link) => s.VisitorId.eq(link.VisitorId))
			.select(($) => ({ key: personKey(keyBy, $, $[LINK_ALIAS]) }))
			.where(($) => replaysWhere($, scoped))
			.groupBy("key")
	}
	return from(SessionReplays)
		.select(($) => ({ key: personKey(keyBy, $) }))
		.where(($) => replaysWhere($, scoped))
		.groupBy("key")
}

const stepColumn = (index: number) => `s${index + 1}`

/** `{ s1: …, s2: …, … }` — one projected flag column per step, in order. */
function stepFlags(
	steps: ReadonlyArray<FunnelStep>,
	value: (step: FunnelStep, index: number) => CH.Expr<number>,
): Record<string, CH.Expr<number>> {
	return Object.fromEntries(steps.map((step, index) => [stepColumn(index), value(step, index)]))
}

/**
 * A query over `Cols` whose join map is left open. The branch builders attach
 * joins conditionally (identity links for `person`, session dimensions for a
 * breakdown), so the joined shape is not one static type; under an open map an
 * alias resolves to untyped column refs and the builder only reads the aliases
 * it declared. The `Output` is `{}` because `select` is the last call.
 */
type OpenJoinQuery<Cols extends ColumnDefs> = CHQuery<Cols, {}, Record<string, ColumnDefs>>
type OpenJoinAccessor<Cols extends ColumnDefs> = JoinedColumnAccessor<Cols, Record<string, ColumnDefs>>

interface FunnelPlan {
	readonly opts: ProductEventsFunnelOpts
	readonly filters: ProductEventsFilters
	readonly sessionStep: Extract<FunnelStep, { kind: "session" }> | undefined
	/** Set when a breakdown wants a per-row dimension projected as `dim`. */
	readonly breakdownBy?: FunnelBreakdownBy
}

/**
 * The events branch: every `product_events` row in range that matches at least
 * one step, projected to `(key, ts, s1..sN[, dim])`.
 *
 * Only rows matching *some* step are read — a funnel over three events does not
 * scan every page view in the range. The step flags are computed here so the
 * aggregate layer never sees `EventName`/`PagePath`/`Attributes` at all.
 */
function eventsBranch(plan: FunnelPlan): FunnelBranch {
	const { opts, filters, breakdownBy } = plan
	const keyBy = opts.keyBy
	const dim = breakdownBy
	// `host` is a session dimension too, but product_events carries it on every
	// browser row, so it is read there rather than joined in.
	const sessionDimension =
		dim !== undefined && !dim.startsWith("attribute:") && dim !== "host"
			? (dim as FunnelSessionDimension)
			: undefined

	// Per-session acquisition dimension for a session-dimension breakdown.
	// `max()` so the v2 row's value beats a v1 row's ''.
	const sessionDims = sessionDimension
		? from(SessionReplays)
				.select(($) => ({
					SessionId: $.SessionId,
					Value: CH.max_(sessionDimensionColumn($, sessionDimension)),
				}))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.StartTime.gte(param.dateTime("startTime")),
					$.StartTime.lte(param.dateTime("endTime")),
				])
				.groupBy("SessionId")
		: undefined

	// The joins differ by keyBy/breakdown, so the query is held under an open
	// join map: joined aliases resolve to untyped column refs, and only the
	// aliases actually declared above are ever read.
	let base: OpenJoinQuery<typeof ProductEvents.columns> = from(ProductEvents, "e")
	if (keyBy === "person") {
		base = base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
			e.VisitorId.eq(link.VisitorId),
		)
	}
	if (sessionDims) {
		base = base.leftJoinQuery(sessionDims, "sd", (e, sd) => e.SessionId.eq(sd.SessionId))
	}

	const dimExpr = ($: OpenJoinAccessor<typeof ProductEvents.columns>): CH.Expr<string> | undefined => {
		if (dim === undefined) return undefined
		if (dim.startsWith("attribute:")) return $.Attributes.get(dim.slice("attribute:".length))
		if (dim === "host") return $.Host
		return compileFnCall<string>("coalesce", $.sd.Value, CH.lit(""))
	}

	return base
		.select(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const flags = stepFlags(opts.steps, (step) => {
				const cond = eventStepCondition($, step)
				return cond ? flag(cond) : CH.lit(0)
			})
			const d = dimExpr($)
			const row = { key, ts: epochMs($.Timestamp), ...flags }
			return d ? { ...row, dim: d } : row
		})
		.where(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const stepConditions = opts.steps
				.map((step) => eventStepCondition($, step))
				.filter((cond): cond is CH.Condition => cond !== undefined)
			const anyStep = stepConditions.reduce<CH.Condition | undefined>(
				(acc, cond) => (acc ? acc.or(cond) : cond),
				undefined,
			)
			return [
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
				anyStep,
				key.neq(""),
				hasPopulationFilter(filters)
					? inSubquery(key, matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})
}

/**
 * The session-entry branch for a `session` step 1: one synthetic
 * `$session_entry` row per matching session at its `StartTime`, with `s1 = 1`
 * and every other step 0. Un-merged v1/v2 rows of one session yield two chain
 * starts at the same instant, which `windowFunnel` treats as one.
 */
function sessionEntryBranch(plan: FunnelPlan, step: Extract<FunnelStep, { kind: "session" }>): FunnelBranch {
	const { opts, filters, breakdownBy } = plan
	const keyBy = opts.keyBy
	const dim = breakdownBy
	const sessionDimension =
		dim !== undefined && !dim.startsWith("attribute:") ? (dim as FunnelSessionDimension) : undefined

	let base: OpenJoinQuery<typeof SessionReplays.columns> = from(SessionReplays, "s")
	if (keyBy === "person") {
		base = base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (s, link) =>
			s.VisitorId.eq(link.VisitorId),
		)
	}

	return base
		.select(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const flags = stepFlags(opts.steps, (_, index) => CH.lit(index === 0 ? 1 : 0))
			const row = { key, ts: epochMs($.StartTime), ...flags }
			if (dim === undefined) return row
			// An attribute breakdown has no value on a session row; the events
			// branch supplies it. A session dimension is read straight off the row.
			return {
				...row,
				dim: sessionDimension ? sessionDimensionColumn($, sessionDimension) : CH.lit(""),
			}
		})
		.where(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			return [
				$.OrgId.eq(param.string("orgId")),
				$.StartTime.gte(param.dateTime("startTime")),
				$.StartTime.lte(param.dateTime("endTime")),
				sessionDimensionColumn($, step.dimension).eq(step.value),
				key.neq(""),
				hasPopulationFilter(filters)
					? inSubquery(key, matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})
}

/**
 * `SELECT key, windowFunnel(w)(ts, s1 = 1, …, sN = 1) AS level [, first dim AS group]
 *  FROM <events ∪ session entries> GROUP BY key` — one row per person with the
 * deepest step they reached in order within the window.
 *
 * A funnel whose ONLY step is a `session` step has no event predicate at all, so
 * the events branch would have nothing to filter on and would read every
 * `product_events` row in range to project `s1..sN` as zeros — rows that can
 * never reach a level. That funnel is answered by the session-entry branch
 * alone, which is the state the step builder is in the moment step 1 becomes a
 * session step, so the branch is dropped rather than scanned.
 */
function levelsQuery(plan: FunnelPlan) {
	const { opts } = plan
	const hasEventStep = opts.steps.some((step) => step.kind !== "session")
	const source = plan.sessionStep
		? hasEventStep
			? fromUnion(
					unionAll<FunnelEventRow>(sessionEntryBranch(plan, plan.sessionStep), eventsBranch(plan)),
					"funnel_events",
				)
			: fromQuery(sessionEntryBranch(plan, plan.sessionStep), "funnel_events")
		: fromQuery(eventsBranch(plan), "funnel_events")

	return source
		.select(($) => {
			const ts = $.ts as CH.Expr<number>
			const conditions = opts.steps.map((_, index) => ($[stepColumn(index)] as CH.Expr<number>).eq(1))
			const row = {
				key: $.key as CH.Expr<string>,
				level: CH.windowFunnel(opts.windowSeconds * 1000)(ts, ...conditions),
			}
			if (plan.breakdownBy === undefined) return row
			const dim = $.dim as CH.Expr<string>
			return { ...row, group: argMinIf(dim, ts, dim.neq("")) }
		})
		.groupBy("key")
}

/** `[countIf(level >= 1), …, countIf(level >= N)]` over a levels row set. */
function stepCounts(stepCount: number): CH.Expr<ReadonlyArray<number>> {
	const level = CH.dynamicColumn<number>("level")
	return CH.arrayOf(...Array.from({ length: stepCount }, (_, i) => CH.countIf(level.gte(i + 1))))
}

/** `arrayJoin([1, …, N])` — one output row per step. */
function stepIndex(stepCount: number): CH.Expr<number> {
	return CH.arrayJoin(CH.arrayOf(...Array.from({ length: stepCount }, (_, i) => CH.lit(i + 1))))
}

// Public builders

/**
 * Per-step funnel counts: how many persons (per `keyBy`) reached at least step
 * `n`, in order, within `windowSeconds` of their step-1 event.
 *
 * Always returns exactly `steps.length` rows, `step` 1..N ascending, so an
 * empty range decodes as a row of zeros per step rather than as no rows.
 * Conversion rates are the caller's division — the numbers here are the
 * counts the UI shows next to them.
 */
export function productEventsFunnelQuery(
	opts: ProductEventsFunnelOpts,
): CHQuery<any, ProductEventsFunnelOutput, any> {
	validate(opts)
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = {
		opts,
		filters,
		sessionStep: first?.kind === "session" ? first : undefined,
	}
	const n = opts.steps.length

	const totals = fromQuery(levelsQuery(plan), "levels").select(() => ({ counts: stepCounts(n) }))

	return fromQuery(totals, "totals")
		.select(($) => ({
			step: stepIndex(n),
			count: arrayElement($.counts, CH.dynamicColumn<number>("step")),
		}))
		.orderBy(["step", "asc"])
		.format("JSON")
}

/**
 * The same funnel, split by one dimension: `{ group, step, count }` for the top
 * `limit` groups by step-1 count. Every kept group emits all N steps.
 *
 * A person's group is the first non-empty value of the dimension across their
 * rows in range (`argMinIf(dim, ts, dim != '')`) — for a session dimension that
 * is their earliest session's referrer / campaign / country, for `host` the
 * first host they were seen on, for `attribute:<k>` the first event carrying
 * it. Persons with no value at all land in the `''` group, which the caller
 * may label or drop.
 *
 * Rows come back ordered by `group`, then `step`; the step-1 row of each group
 * carries the rank the `limit` was applied on.
 */
export function productEventsFunnelBreakdownQuery(
	opts: ProductEventsFunnelBreakdownOpts,
): CHQuery<any, ProductEventsFunnelBreakdownOutput, any> {
	validate(opts)
	const limit = opts.limit ?? 10
	if (!Number.isInteger(limit) || limit < 1 || limit > FUNNEL_BREAKDOWN_MAX_GROUPS) {
		throw new ProductEventsFunnelError({
			reason: "InvalidLimit",
			message: `breakdown limit must be an integer in 1..${FUNNEL_BREAKDOWN_MAX_GROUPS}, got ${String(limit)}`,
		})
	}
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = {
		opts,
		filters,
		sessionStep: first?.kind === "session" ? first : undefined,
		breakdownBy: opts.breakdownBy,
	}
	const n = opts.steps.length

	const perGroup = fromQuery(levelsQuery(plan), "levels")
		.select(() => ({
			group: CH.dynamicColumn<string>("group"),
			counts: stepCounts(n),
			entered: CH.countIf(CH.dynamicColumn<number>("level").gte(1)),
		}))
		.groupBy("group")
		.orderBy(["entered", "desc"], ["group", "asc"])
		.limit(limit)

	return fromQuery(perGroup, "groups")
		.select(($) => ({
			group: $.group,
			step: stepIndex(n),
			count: arrayElement($.counts, CH.dynamicColumn<number>("step")),
		}))
		.orderBy(["group", "asc"], ["step", "asc"])
		.format("JSON")
}

/**
 * Event names in range for the step picker: `{ eventName, kind, count,
 * sessions, persons }`, most frequent first.
 *
 * `persons` is the unstitched `if(UserId != '', UserId, VisitorId)` — a cheap
 * approximation that needs no `identity_links` join; the funnel itself does the
 * stitching. Sidebar filters narrow by `SessionId`, so under an active filter
 * server-side events (which carry no session) are not listed.
 */
export function productEventNamesQuery(
	opts: ProductEventNamesOpts = {},
): CHQuery<any, ProductEventNamesOutput, any> {
	const filters: ProductEventsFilters = { ...opts.filters, useProductEvents: true }
	const limit = opts.limit ?? 100
	return from(ProductEvents)
		.select(($) => ({
			eventName: $.EventName,
			kind: $.Kind,
			count: CH.count(),
			sessions: CH.uniqIf($.SessionId, $.SessionId.neq("")),
			persons: CH.uniq(CH.if_($.UserId.neq(""), $.UserId, $.VisitorId)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(filters.host, (v: string) => $.Host.eq(v)),
			needsSessionSemiJoin(filters) || filters.pagePath !== undefined
				? inSubquery(
						$.SessionId,
						from(SessionReplays)
							.select(($s) => ({ sessionId: $s.SessionId }))
							.where(($s) => replaysWhere($s, { ...filters, host: undefined }))
							.groupBy("sessionId"),
					)
				: undefined,
		])
		.groupBy("eventName", "kind")
		.orderBy(["count", "desc"], ["eventName", "asc"])
		.limit(limit)
		.format("JSON")
}
