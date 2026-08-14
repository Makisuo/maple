import type { GetServiceEndpointsInput } from "@/api/warehouse/service-endpoints"
import { OPERATIONS_LIMIT, operationsBucketSeconds } from "./service-operations"

/**
 * The shared atom-family input for the endpoints query. The Overview panel and
 * the Endpoints tab both build their key through this, so opening the tab after
 * seeing the panel is a cache hit — the same trick `serviceOperationsQueryInput`
 * plays for Operations.
 *
 * Bucket sizing and limit are deliberately borrowed from the operations helpers
 * rather than re-derived: the two tables sit side by side and a divergence would
 * read as a data bug.
 */
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
		bucketSeconds: operationsBucketSeconds(args.effectiveStartTime, args.effectiveEndTime),
		limit: OPERATIONS_LIMIT,
	}
}

/**
 * Tailwind classes per HTTP verb, keyed on read/write/destroy rather than on a
 * per-verb palette: the useful signal when scanning a route table is "does this
 * change anything", not "which of the seven verbs is it".
 */
export function methodTone(method: string): string {
	switch (method.toUpperCase()) {
		case "GET":
		case "HEAD":
		case "OPTIONS":
			return "text-severity-info/90 bg-severity-info/10"
		case "POST":
		case "PUT":
		case "PATCH":
			return "text-severity-warn/90 bg-severity-warn/10"
		case "DELETE":
			return "text-severity-error/90 bg-severity-error/10"
		default:
			return "text-muted-foreground bg-muted"
	}
}

/**
 * Split a route so the distinguishing end of it survives truncation.
 *
 * Endpoints on one service overwhelmingly share a prefix — a table of
 * `/subscriptions/v2/{id}/cancel`, `/subscriptions/v2/{id}/refund`,
 * `/subscriptions/v2/search` end-truncated to `/subscriptions…` is fifteen
 * identical rows. Rendering `head` as the shrinking part and `tail` as a
 * fixed one elides the middle instead, so the last segment is always readable.
 */
export function splitRouteForDisplay(route: string): { head: string; tail: string } {
	const lastSlash = route.lastIndexOf("/")
	// No separator, or the only slash is the leading one: there is no shared
	// prefix to give up, so the whole route is the tail.
	if (lastSlash <= 0) return { head: "", tail: route }
	return { head: route.slice(0, lastSlash), tail: route.slice(lastSlash) }
}

/** Search params for the endpoint detail route. */
export function endpointDetailSearch(args: {
	method: string
	route: string
	environments?: readonly string[]
	startTime?: string
	endTime?: string
	timePreset?: string
}) {
	return {
		method: args.method,
		route: args.route,
		environments: args.environments?.length ? [...args.environments] : undefined,
		startTime: args.startTime,
		endTime: args.endTime,
		timePreset: args.timePreset,
	}
}

/**
 * The display span name the warehouse keys on, recomposed from the split halves
 * the detail route carries in its URL. Every query filter on that route goes
 * through this — `route` alone matches nothing.
 */
export function endpointSpanName(method: string, route: string): string {
	return `${method} ${route}`
}
