// One filter schema shared by all five queries, so the /analytics route builds a
// single filter object and every panel narrows identically. See
// packages/query-engine/src/ch/queries/web-analytics.ts for why the page reads
// two tables and what each half covers.

import { Effect, Schema } from "effect"
import {
	WebAnalyticsBreakdownsRequest,
	WebAnalyticsPagesRequest,
	WebAnalyticsPageviewsRequest,
	WebAnalyticsSummaryRequest,
	WebAnalyticsTimeseriesRequest,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

export const WebAnalyticsFilterFields = {
	host: Schema.optional(Schema.String),
	pagePath: Schema.optional(Schema.String),
	referrerHost: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	browserName: Schema.optional(Schema.String),
	osName: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	utmSource: Schema.optional(Schema.String),
	utmMedium: Schema.optional(Schema.String),
	utmCampaign: Schema.optional(Schema.String),
	visitorType: Schema.optional(Schema.Literals(["new", "returning"])),
} as const

export const TimeWindowFields = {
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
} as const

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const WebAnalyticsSummaryInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
})

const WebAnalyticsTimeseriesInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	bucketSeconds: Schema.optional(PositiveInt),
})

const WebAnalyticsPagesInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	limit: Schema.optional(PositiveInt),
})

const WebAnalyticsBreakdownsInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	limitPerDimension: Schema.optional(PositiveInt),
})

export type GetWebAnalyticsSummaryInput = (typeof WebAnalyticsSummaryInputSchema)["Encoded"]
export type GetWebAnalyticsTimeseriesInput = (typeof WebAnalyticsTimeseriesInputSchema)["Encoded"]
export type GetWebAnalyticsPagesInput = (typeof WebAnalyticsPagesInputSchema)["Encoded"]
export type GetWebAnalyticsBreakdownsInput = (typeof WebAnalyticsBreakdownsInputSchema)["Encoded"]

export interface WebAnalyticsSummary {
	visitors: number
	sessions: number
	newSessions: number
	bouncedSessions: number
	identifiedSessions: number
	avgDurationMs: number
	/**
	 * Share of sessions whose SDK build posts the analytics block, i.e. the share
	 * of traffic every visitor-level number on the page actually describes. The
	 * page surfaces it rather than presenting a partial count as the whole.
	 */
	coverage: number
	/**
	 * Bounces over **identified** sessions, 0–1. Not over all sessions: page views
	 * are part of the analytics block, so sessions without it report zero of them
	 * and would every one count as a bounce. `null` when nothing reports page
	 * views — the honest answer there is "unknown", not 0% and not 100%.
	 */
	bounceRate: number | null
}

export interface WebAnalyticsTimeseriesPoint {
	bucket: string
	visitors: number
	sessions: number
	newSessions: number
	/**
	 * Bounces within `identifiedSessions` for this bucket. The bucket's bounce
	 * rate is `bouncedSessions / identifiedSessions` — dividing by `sessions`
	 * counts every session from an SDK build without the analytics block as a
	 * bounce, which is the bug the summary query's doc comment records.
	 */
	bouncedSessions: number
	identifiedSessions: number
	avgDurationMs: number
}

export interface WebAnalyticsPageviewsPoint {
	bucket: string
	pageViews: number
	sessions: number
}

export interface WebAnalyticsPage {
	host: string
	pagePath: string
	pageViews: number
	sessions: number
}

export interface WebAnalyticsFacetRow {
	name: string
	count: number
}

export interface WebAnalyticsBreakdowns {
	referrerHosts: ReadonlyArray<WebAnalyticsFacetRow>
	countries: ReadonlyArray<WebAnalyticsFacetRow>
	deviceTypes: ReadonlyArray<WebAnalyticsFacetRow>
	browsers: ReadonlyArray<WebAnalyticsFacetRow>
	operatingSystems: ReadonlyArray<WebAnalyticsFacetRow>
	languages: ReadonlyArray<WebAnalyticsFacetRow>
	utmSources: ReadonlyArray<WebAnalyticsFacetRow>
	utmMediums: ReadonlyArray<WebAnalyticsFacetRow>
	utmCampaigns: ReadonlyArray<WebAnalyticsFacetRow>
	entryPaths: ReadonlyArray<WebAnalyticsFacetRow>
	exitPaths: ReadonlyArray<WebAnalyticsFacetRow>
	hosts: ReadonlyArray<WebAnalyticsFacetRow>
}

const ratio = (numerator: number, denominator: number): number =>
	denominator > 0 ? numerator / denominator : 0

export function getWebAnalyticsSummary({ data }: { data: GetWebAnalyticsSummaryInput }) {
	return getWebAnalyticsSummaryEffect({ data })
}

const getWebAnalyticsSummaryEffect = Effect.fn("QueryEngine.getWebAnalyticsSummary")(function* ({
	data,
}: {
	data: GetWebAnalyticsSummaryInput
}) {
	const input = yield* decodeInput(WebAnalyticsSummaryInputSchema, data, "getWebAnalyticsSummary")

	const result = yield* runWarehouseQuery("webAnalyticsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.webAnalyticsSummary({
				payload: new WebAnalyticsSummaryRequest(input),
			})
		}),
	)

	const row = result.data
	return {
		...row,
		coverage: ratio(row.identifiedSessions, row.sessions),
		bounceRate: row.identifiedSessions > 0 ? row.bouncedSessions / row.identifiedSessions : null,
	} satisfies WebAnalyticsSummary
})

export function getWebAnalyticsTimeseries({ data }: { data: GetWebAnalyticsTimeseriesInput }) {
	return getWebAnalyticsTimeseriesEffect({ data })
}

const getWebAnalyticsTimeseriesEffect = Effect.fn("QueryEngine.getWebAnalyticsTimeseries")(function* ({
	data,
}: {
	data: GetWebAnalyticsTimeseriesInput
}) {
	const input = yield* decodeInput(WebAnalyticsTimeseriesInputSchema, data, "getWebAnalyticsTimeseries")

	const result = yield* runWarehouseQuery("webAnalyticsTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.webAnalyticsTimeseries({
				payload: new WebAnalyticsTimeseriesRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<WebAnalyticsTimeseriesPoint> }
})

export function getWebAnalyticsPageviews({ data }: { data: GetWebAnalyticsTimeseriesInput }) {
	return getWebAnalyticsPageviewsEffect({ data })
}

const getWebAnalyticsPageviewsEffect = Effect.fn("QueryEngine.getWebAnalyticsPageviews")(function* ({
	data,
}: {
	data: GetWebAnalyticsTimeseriesInput
}) {
	const input = yield* decodeInput(WebAnalyticsTimeseriesInputSchema, data, "getWebAnalyticsPageviews")

	const result = yield* runWarehouseQuery("webAnalyticsPageviews", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.webAnalyticsPageviews({
				payload: new WebAnalyticsPageviewsRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<WebAnalyticsPageviewsPoint> }
})

export function getWebAnalyticsPages({ data }: { data: GetWebAnalyticsPagesInput }) {
	return getWebAnalyticsPagesEffect({ data })
}

const getWebAnalyticsPagesEffect = Effect.fn("QueryEngine.getWebAnalyticsPages")(function* ({
	data,
}: {
	data: GetWebAnalyticsPagesInput
}) {
	const input = yield* decodeInput(WebAnalyticsPagesInputSchema, data, "getWebAnalyticsPages")

	const result = yield* runWarehouseQuery("webAnalyticsPages", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.webAnalyticsPages({
				payload: new WebAnalyticsPagesRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<WebAnalyticsPage> }
})

export function getWebAnalyticsBreakdowns({ data }: { data: GetWebAnalyticsBreakdownsInput }) {
	return getWebAnalyticsBreakdownsEffect({ data })
}

const getWebAnalyticsBreakdownsEffect = Effect.fn("QueryEngine.getWebAnalyticsBreakdowns")(function* ({
	data,
}: {
	data: GetWebAnalyticsBreakdownsInput
}) {
	const input = yield* decodeInput(WebAnalyticsBreakdownsInputSchema, data, "getWebAnalyticsBreakdowns")

	const result = yield* runWarehouseQuery("webAnalyticsBreakdowns", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.webAnalyticsBreakdowns({
				payload: new WebAnalyticsBreakdownsRequest(input),
			})
		}),
	)

	return result.data satisfies WebAnalyticsBreakdowns
})
