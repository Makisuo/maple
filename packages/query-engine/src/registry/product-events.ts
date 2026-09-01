import type {
	ProductEventNamesRequest,
	ProductEventsForTraceRequest,
	ProductEventsFunnelBreakdownRequest,
	ProductEventsFunnelRequest,
	ProductEventTraceSamplesRequest,
} from "@maple/domain/http"
import * as CH from "../ch"
import { timeRangeCache } from "../runtime/query-engine"
import { defineQuery } from "./query-definition"

// Product-event funnels read `product_events` only — server and mobile rows have
// no raw `session_events` counterpart, so unlike the web-analytics pairs there is
// no `Raw` twin to fall back to. The builders validate the funnel definition
// synchronously and throw `ProductEventsFunnelError`; the HTTP handler checks the
// definition through `productEventsFunnelOpts` before `compile` runs here so a
// bad definition is a 400 rather than a defect.

/** The web-analytics filter surface, read off any funnel-family request. */
const productEventsFilters = (payload: ProductEventNamesRequest): CH.ProductEventsFilters => ({
	host: payload.host,
	pagePath: payload.pagePath,
	referrerHost: payload.referrerHost,
	country: payload.country,
	deviceType: payload.deviceType,
	browserName: payload.browserName,
	osName: payload.osName,
	language: payload.language,
	utmSource: payload.utmSource,
	utmMedium: payload.utmMedium,
	utmCampaign: payload.utmCampaign,
	visitorType: payload.visitorType,
	useProductEvents: true,
})

/** The funnel option bag shared by the plain and breakdown queries. */
export const productEventsFunnelOpts = (
	payload: ProductEventsFunnelRequest | ProductEventsFunnelBreakdownRequest,
): CH.ProductEventsFunnelOpts => ({
	steps: payload.steps,
	keyBy: payload.keyBy,
	windowSeconds: payload.windowSeconds,
	filters: productEventsFilters(payload),
})

export const productEventsFunnel = defineQuery({
	id: "productEventsFunnel",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventsFunnelRequest, orgId: string) =>
		CH.compile(CH.productEventsFunnelQuery(productEventsFunnelOpts(payload)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const productEventsFunnelBreakdown = defineQuery({
	id: "productEventsFunnelBreakdown",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventsFunnelBreakdownRequest, orgId: string) =>
		CH.compile(
			CH.productEventsFunnelBreakdownQuery({
				...productEventsFunnelOpts(payload),
				breakdownBy: payload.breakdownBy,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const productEventNames = defineQuery({
	id: "productEventNames",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ProductEventNamesRequest, orgId: string) =>
		CH.compile(
			CH.productEventNamesQuery({
				filters: productEventsFilters(payload),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

// The trace ↔ product-event link, both directions. `list` rather than
// `aggregation`: each reads a handful of rows off a single equality predicate,
// and paying the aggregation profile's settings for a bloom-filter point lookup
// is the wrong trade.
//
// A flat 60s rather than `timeRangeCache`, whose TTL and key-snap widen with the
// range: both of these are point lookups whose answer does not change with how
// much time the caller asked about, and a completed trace's events never change
// at all. 60s covers the burst of re-reads a panel does while someone clicks
// around one trace, and is short enough that an event annotated a minute ago
// shows up in the samples list.

export const productEventsForTrace = defineQuery({
	id: "productEventsForTrace",
	profile: "list",
	cache: 60,
	compile: (payload: ProductEventsForTraceRequest, orgId: string) =>
		CH.compile(CH.productEventsForTraceQuery({ limit: payload.limit ?? 50 }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			traceId: payload.traceId,
		}),
})

export const productEventTraceSamples = defineQuery({
	id: "productEventTraceSamples",
	profile: "list",
	cache: 60,
	compile: (payload: ProductEventTraceSamplesRequest, orgId: string) =>
		CH.compile(CH.productEventTraceSamplesQuery({ limit: payload.limit ?? 20 }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			eventName: payload.eventName,
		}),
})
