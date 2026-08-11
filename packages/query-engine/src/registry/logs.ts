import type { LogsCountQuery, LogsFilters, LogsTimeseriesQuery } from "@maple/domain/query-engine"
import { attributeIndexMode, logBodySearchMode } from "../capabilities"
import * as CH from "../ch"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { defineQuery, makeTimeBucketQueryCachePolicy } from "./query-definition"

export const logsQueryOptions = (filters: LogsFilters | undefined) => {
	const deploymentEnv = filters?.deploymentEnvMatchMode
	const serviceNamespace = filters?.namespaceMatchMode
	const matchModes =
		deploymentEnv === undefined && serviceNamespace === undefined
			? undefined
			: { deploymentEnv, serviceNamespace }

	return {
		serviceName: filters?.serviceName,
		severity: filters?.severity,
		minSeverity: filters?.minSeverity,
		traceId: filters?.traceId,
		spanId: filters?.spanId,
		search: filters?.search,
		environments: filters?.environments,
		namespaces: filters?.namespaces,
		matchModes,
		attributeFilters: filters?.attributeFilters,
		resourceAttributeFilters: filters?.resourceAttributeFilters,
	}
}

export interface LogsCountInput {
	readonly startTime: string
	readonly endTime: string
	readonly filters?: LogsFilters
}

export interface LogsTimeseriesInput extends LogsCountInput {
	readonly bucketSeconds: number
	readonly groupBy?: LogsTimeseriesQuery["groupBy"]
	readonly seriesLimit?: number
}

export const toLogsCountInput = (
	startTime: string,
	endTime: string,
	query: LogsCountQuery,
): LogsCountInput => ({
	startTime,
	endTime,
	filters: query.filters,
})

export const toLogsTimeseriesInput = (
	startTime: string,
	endTime: string,
	query: LogsTimeseriesQuery,
	bucketSeconds: number,
): LogsTimeseriesInput => ({
	startTime,
	endTime,
	bucketSeconds,
	filters: query.filters,
	groupBy: query.groupBy,
	seriesLimit: query.seriesLimit,
})

export const logsCount = defineQuery({
	id: "logsCount",
	revision: 1,
	profile: "discovery",
	cache: 15,
	capabilityAware: true,
	settings: (input: LogsCountInput) => (input.filters?.search ? LOGS_BODY_SEARCH_SETTINGS : undefined),
	compile: (input: LogsCountInput, orgId: string, capabilities) =>
		CH.compile(
			CH.logsCountQuery({
				...logsQueryOptions(input.filters),
				attributeIndexMode: attributeIndexMode(capabilities, "logs"),
				bodySearchMode: logBodySearchMode(capabilities),
			}),
			{ orgId, startTime: input.startTime, endTime: input.endTime },
		),
})

export const logsTimeseries = defineQuery({
	id: "logsTimeseries",
	revision: 1,
	profile: "aggregation",
	cache: makeTimeBucketQueryCachePolicy<LogsTimeseriesInput>({
		// The cache service owns the time range and bucket width. Keeping them out
		// of this identity lets overlapping dashboard windows reuse stored buckets.
		identity: ({ filters, groupBy, seriesLimit }) => ({ filters, groupBy, seriesLimit }),
		fallback: 15,
	}),
	capabilityAware: true,
	compile: (input: LogsTimeseriesInput, orgId: string, capabilities) =>
		CH.compile(
			CH.logsTimeseriesQuery({
				...logsQueryOptions(input.filters),
				attributeIndexMode: attributeIndexMode(capabilities, "logs"),
				bodySearchMode: logBodySearchMode(capabilities),
				groupBy: input.groupBy,
				bucketSeconds: input.bucketSeconds,
				seriesLimit: input.seriesLimit,
			}),
			{
				orgId,
				startTime: input.startTime,
				endTime: input.endTime,
				bucketSeconds: input.bucketSeconds,
			},
		),
})
