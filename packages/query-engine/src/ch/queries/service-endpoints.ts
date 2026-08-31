// Service API Endpoints
//
// The HTTP-server slice of the per-operation rollup: one row per
// `METHOD /route` with throughput, error rate and p50/p95/p99. Backs the "API"
// tab on the service detail page, where the Operations tab keeps the unfiltered
// ranking (internal spans included).
//
// There is no separate endpoints rollup and there should not be one. The
// normalized name `service_operations_minutely/_hourly` already stores IS the
// endpoint identity for HTTP spans, so this is a filter over an aggregate we
// pay for on every insert — see `httpOnly` in ./service-operations.

import {
	serviceOperationsSummaryQuery,
	serviceOperationsSummaryRawQuery,
	serviceOperationsSummaryRowSchema,
	type ServiceOperationsSummaryOpts,
	type ServiceOperationsSummaryOutput,
} from "./service-operations"

export type ServiceEndpointsSummaryOpts = Omit<ServiceOperationsSummaryOpts, "httpOnly">

export type ServiceEndpointsSummaryOutput = ServiceOperationsSummaryOutput

export const serviceEndpointsSummaryRowSchema = serviceOperationsSummaryRowSchema

export function serviceEndpointsSummaryQuery(opts: ServiceEndpointsSummaryOpts) {
	return serviceOperationsSummaryQuery({ ...opts, httpOnly: true })
}

/** All-raw rollback companion, for clusters without migration 0008. */
export function serviceEndpointsSummaryRawQuery(opts: ServiceEndpointsSummaryOpts) {
	return serviceOperationsSummaryRawQuery({ ...opts, httpOnly: true })
}

export interface EndpointName {
	/** Uppercase HTTP method, e.g. `GET`. */
	readonly method: string
	/** Route template or URL path, e.g. `/api/users/{id}`. */
	readonly route: string
}

/**
 * Split a normalized endpoint name into its parts for display.
 *
 * Done here rather than in SQL: the split is one `position()` on a value the
 * query already groups by, and keeping it out of the SELECT avoids an
 * alias-ordering dependency in the outer union for no measurable gain. A name
 * the HTTP filter let through always contains the separator; the fallback exists
 * so a malformed row renders as a route rather than throwing.
 */
export function splitEndpointName(spanName: string): EndpointName {
	const separator = spanName.indexOf(" ")
	if (separator <= 0) return { method: "", route: spanName }
	return { method: spanName.slice(0, separator), route: spanName.slice(separator + 1) }
}
