import type { GetServiceEndpointsInput } from "@/api/warehouse/service-endpoints"

/**
 * The list is capped server-side by traffic, BEFORE the browser classifies
 * probes and unrouted paths — so a noisy service can spend part of the budget on
 * rows that end up collapsed. 200 rather than the Operations tab's 25 because
 * this tab draws no sparklines: it issues no companion timeseries, so it is not
 * bounded by that query's 10k `rows × buckets` ceiling, and the summary is a
 * single aggregate over the rollup either way.
 *
 * Classifying before the limit would need the warehouse to know which rows are
 * endpoints at all, which is the same `http.route` discriminator the collapsed
 * buckets are guessing at. Until that exists the cap is stated in the UI rather
 * than hidden — see `isTruncated`.
 *
 * KNOWN LIMITATION, and it is not cosmetic. Because the cap is applied by the
 * warehouse (by traffic) BEFORE the browser classifies anything, a service whose
 * routes are mostly raw URL paths can spend the entire budget on rows that then
 * collapse. Measured on Maple's own org over 30 days: `maple-landing` has 12,940
 * endpoint-shaped names, essentially all unrouted. This tab asks for its 200
 * busiest, classifies all 200 as unrouted, and renders no endpoints at all —
 * under one collapsed row reading "200 paths", which is not the real number, and
 * a notice claiming the 200 busiest endpoints are on screen.
 *
 * `maple-api` shows the milder form: 360 real endpoints, so the cap genuinely
 * truncates a legitimate list.
 *
 * Both are fixed by the same rollup discriminator, not by a bigger number here —
 * with `HasRoute`/`SpanKind` in the GROUP BY the cap applies to real endpoints
 * only and the collapsed buckets carry true counts instead of capped ones.
 */
export const ENDPOINTS_LIMIT = 200

export function serviceEndpointsQueryInput(args: {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: readonly string[]
}): GetServiceEndpointsInput {
	return {
		serviceName: args.serviceName,
		startTime: args.effectiveStartTime,
		endTime: args.effectiveEndTime,
		environments: args.environments?.length ? args.environments : undefined,
		limit: ENDPOINTS_LIMIT,
	}
}

/** The warehouse returned a full page, so there are probably more endpoints. */
export function isTruncated(returned: number): boolean {
	return returned >= ENDPOINTS_LIMIT
}
