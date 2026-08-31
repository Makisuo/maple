import type { GetServiceEndpointsInput } from "@/api/warehouse/service-endpoints"
import { OPERATIONS_SPARKLINE_BUCKETS, windowSeconds } from "./service-operations"

/** Endpoints are a filtered slice of a service's operations, so the list is
 *  shorter for the same window; a higher cap costs the same single scan. */
export const ENDPOINTS_LIMIT = 50

export function endpointsBucketSeconds(startTime: string, endTime: string): number {
	const targetMinutes = windowSeconds(startTime, endTime) / OPERATIONS_SPARKLINE_BUCKETS / 60
	return Math.max(1, Math.round(targetMinutes)) * 60
}

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
		bucketSeconds: endpointsBucketSeconds(args.effectiveStartTime, args.effectiveEndTime),
		limit: ENDPOINTS_LIMIT,
	}
}
