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
