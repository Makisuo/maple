import { Clock, Effect, Schema } from "effect"
import {
	QueryEngineExecuteRequest,
	coerceErrorsByTypeRows,
	coerceErrorsSummary,
	warehouseDateTimeToIso,
	formatWarehouseDateTime,
} from "@maple/query-engine"
import {
	DeploymentEnvironment,
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ErrorDetailTracesRequest,
	ErrorsSparkRequest,
	FingerprintHash,
	ServiceName,
	ServiceNamespace,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { scopeServicesToNamespaces } from "@/api/warehouse/namespace-scope"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractFacets,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

const OptionalServiceArray = Schema.optional(Schema.mutable(Schema.Array(ServiceName)))
const OptionalDeploymentEnvArray = Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment)))
const OptionalFingerprintHashArray = Schema.optional(Schema.mutable(Schema.Array(FingerprintHash)))
// The error-events tables carry no ServiceNamespace column, so a namespaces
// filter is lowered to service membership via `scopeServicesToNamespaces`.
const OptionalNamespaceArray = Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace)))
/** "Error Type" / "Version" sidebar facets — plain strings, not branded. */
const OptionalStringArray = Schema.optional(Schema.mutable(Schema.Array(Schema.String)))

export interface ErrorByType {
	fingerprintHash: string
	errorLabel: string
	sampleMessage: string
	count: number
	affectedServicesCount: number
	firstSeen: Date
	lastSeen: Date
}

const GetErrorsByTypeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	deploymentEnvs: OptionalDeploymentEnvArray,
	namespaces: OptionalNamespaceArray,
	fingerprintHashes: OptionalFingerprintHashArray,
	errorLabels: OptionalStringArray,
	serviceVersions: OptionalStringArray,
	excludedServices: OptionalServiceArray,
	excludedDeploymentEnvs: OptionalDeploymentEnvArray,
	excludedErrorLabels: OptionalStringArray,
	excludedServiceVersions: OptionalStringArray,
	limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsByTypeInput = (typeof GetErrorsByTypeInputSchema)["Encoded"]

export function getErrorsByType({ data }: { data: GetErrorsByTypeInput }) {
	return getErrorsByTypeEffect({ data })
}

const getErrorsByTypeEffect = Effect.fn("QueryEngine.getErrorsByType")(function* ({
	data,
}: {
	data: GetErrorsByTypeInput
}) {
	const input = yield* decodeInput(GetErrorsByTypeInputSchema, data ?? {}, "getErrorsByType")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const scope = yield* scopeServicesToNamespaces({
		namespaces: input.namespaces,
		services: input.services,
		startTime,
		endTime,
	})
	if (scope.empty) return { data: coerceErrorsByTypeRows([]) }

	const result = yield* runWarehouseQuery("errorsByType", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.errorsByType({
				payload: new ErrorsByTypeRequest({
					startTime,
					endTime,
					rootOnly: input.rootOnly,
					services: scope.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
					errorLabels: input.errorLabels,
					serviceVersions: input.serviceVersions,
					excludedServices: input.excludedServices,
					excludedDeploymentEnvs: input.excludedDeploymentEnvs,
					excludedErrorLabels: input.excludedErrorLabels,
					excludedServiceVersions: input.excludedServiceVersions,
					limit: input.limit,
				}),
			})
		}),
	)

	// Shared with the share API's `errors_by_type` plan.
	return { data: coerceErrorsByTypeRows(result.data) }
})

interface FacetItem {
	name: string
	count: number
}

const GetErrorsFacetsInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	deploymentEnvs: OptionalDeploymentEnvArray,
	namespaces: OptionalNamespaceArray,
	fingerprintHashes: OptionalFingerprintHashArray,
	errorLabels: OptionalStringArray,
	serviceVersions: OptionalStringArray,
	excludedServices: OptionalServiceArray,
	excludedDeploymentEnvs: OptionalDeploymentEnvArray,
	excludedErrorLabels: OptionalStringArray,
	excludedServiceVersions: OptionalStringArray,
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsFacetsInput = (typeof GetErrorsFacetsInputSchema)["Encoded"]

const defaultErrorsTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

export function getErrorsFacets({ data }: { data: GetErrorsFacetsInput }) {
	return getErrorsFacetsEffect({ data })
}

const getErrorsFacetsEffect = Effect.fn("QueryEngine.getErrorsFacets")(function* ({
	data,
}: {
	data: GetErrorsFacetsInput
}) {
	const input = yield* decodeInput(GetErrorsFacetsInputSchema, data ?? {}, "getErrorsFacets")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const scope = yield* scopeServicesToNamespaces({
		namespaces: input.namespaces,
		services: input.services,
		startTime,
		endTime,
	})
	if (scope.empty) {
		return { data: { services: [], deploymentEnvs: [], errorTypes: [], serviceVersions: [] } }
	}

	const response = yield* executeQueryEngine(
		"queryEngine.getErrorsFacets",
		new QueryEngineExecuteRequest({
			startTime,
			endTime,
			query: {
				kind: "facets" as const,
				source: "errors" as const,
				filters: {
					rootOnly: input.rootOnly,
					services: scope.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
					errorLabels: input.errorLabels,
					serviceVersions: input.serviceVersions,
					excludedServices: input.excludedServices,
					excludedDeploymentEnvs: input.excludedDeploymentEnvs,
					excludedErrorLabels: input.excludedErrorLabels,
					excludedServiceVersions: input.excludedServiceVersions,
				},
			},
		}),
	)

	const facetsData = extractFacets(response)
	// The services facet branch deliberately ignores the services filter (see
	// `except` in `errorsFacetsQuery`), which would resurface out-of-namespace
	// service names while namespace-scoped — drop them here.
	const inScope = (row: { facetType: string; name: string }) =>
		scope.memberServices === null || row.facetType !== "service" || scope.memberServices.has(row.name)
	const services: FacetItem[] = []
	const deploymentEnvs: FacetItem[] = []
	const errorTypes: FacetItem[] = []
	const serviceVersions: FacetItem[] = []

	for (const row of facetsData) {
		if (!inScope(row)) continue
		const item = { name: row.name, count: Number(row.count) }
		// These strings must match the `facetType` literals in `errorsFacetsQuery`.
		// They did not: the query emits "environment"/"error_type" and this read
		// "deploymentEnv"/"errorType", so those two sections rendered with zero
		// options and the sidebar looked like it had no environment filter at all.
		switch (row.facetType) {
			case "service":
				services.push(item)
				break
			case "environment":
				deploymentEnvs.push(item)
				break
			case "error_type":
				errorTypes.push(item)
				break
			case "version":
				serviceVersions.push(item)
				break
		}
	}

	return {
		data: { services, deploymentEnvs, errorTypes, serviceVersions },
	}
})

const GetErrorsSummaryInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	deploymentEnvs: OptionalDeploymentEnvArray,
	namespaces: OptionalNamespaceArray,
	fingerprintHashes: OptionalFingerprintHashArray,
	errorLabels: OptionalStringArray,
	serviceVersions: OptionalStringArray,
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsSummaryInput = (typeof GetErrorsSummaryInputSchema)["Encoded"]

export function getErrorsSummary({ data }: { data: GetErrorsSummaryInput }) {
	return getErrorsSummaryEffect({ data })
}

const getErrorsSummaryEffect = Effect.fn("QueryEngine.getErrorsSummary")(function* ({
	data,
}: {
	data: GetErrorsSummaryInput
}) {
	const input = yield* decodeInput(GetErrorsSummaryInputSchema, data ?? {}, "getErrorsSummary")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const scope = yield* scopeServicesToNamespaces({
		namespaces: input.namespaces,
		services: input.services,
		startTime,
		endTime,
	})
	if (scope.empty) return { data: coerceErrorsSummary(null) }

	const result = yield* runWarehouseQuery("errorsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.errorsSummary({
				payload: new ErrorsSummaryRequest({
					startTime,
					endTime,
					rootOnly: input.rootOnly,
					services: scope.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
					errorLabels: input.errorLabels,
					serviceVersions: input.serviceVersions,
				}),
			})
		}),
	)

	// Shared with the share API's `errors_summary` plan.
	return { data: coerceErrorsSummary(result.data) }
})

const GetErrorDetailTracesInputSchema = Schema.Struct({
	fingerprintHash: FingerprintHash,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorDetailTracesInput = (typeof GetErrorDetailTracesInputSchema)["Encoded"]

export function getErrorDetailTraces({ data }: { data: GetErrorDetailTracesInput }) {
	return getErrorDetailTracesEffect({ data })
}

const getErrorDetailTracesEffect = Effect.fn("QueryEngine.getErrorDetailTraces")(function* ({
	data,
}: {
	data: GetErrorDetailTracesInput
}) {
	const input = yield* decodeInput(GetErrorDetailTracesInputSchema, data ?? {}, "getErrorDetailTraces")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("errorDetailTraces", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.errorDetailTraces({
				payload: new ErrorDetailTracesRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					fingerprintHash: input.fingerprintHash,
					rootOnly: input.rootOnly,
					services: input.services,
					limit: input.limit,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			traceId: raw.traceId,
			startTime: new Date(warehouseDateTimeToIso(raw.startTime)),
			durationMicros: Number(raw.durationMicros),
			spanCount: Number(raw.spanCount),
			services: [...raw.services],
			rootSpanName: raw.rootSpanName,
			errorMessage: raw.errorMessage,
		})),
	}
})

export interface ErrorsTimeseriesItem {
	bucket: string
	count: number
}

/**
 * Bucketed counts for many fingerprints at once, pivoted into one series per
 * fingerprint. The warehouse returns tall rows; the list draws one sparkline
 * per row, so the pivot happens once here rather than in every row component.
 *
 * Buckets are sparse — a fingerprint that was quiet for an hour has no row for
 * it. Densifying is the caller's job, since only it knows the bucket grid.
 */
export interface ErrorsSparkSeries {
	fingerprintHash: string
	points: ReadonlyArray<ErrorsTimeseriesItem>
}

const GetErrorsSparkInputSchema = Schema.Struct({
	fingerprintHashes: Schema.mutable(Schema.Array(FingerprintHash)),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	deploymentEnvs: OptionalDeploymentEnvArray,
	namespaces: OptionalNamespaceArray,
	errorLabels: OptionalStringArray,
	serviceVersions: OptionalStringArray,
	excludedServices: OptionalServiceArray,
	excludedDeploymentEnvs: OptionalDeploymentEnvArray,
	excludedErrorLabels: OptionalStringArray,
	excludedServiceVersions: OptionalStringArray,
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

export type GetErrorsSparkInput = (typeof GetErrorsSparkInputSchema)["Encoded"]

export function getErrorsSpark({ data }: { data: GetErrorsSparkInput }) {
	return getErrorsSparkEffect({ data })
}

const getErrorsSparkEffect = Effect.fn("QueryEngine.getErrorsSpark")(function* ({
	data,
}: {
	data: GetErrorsSparkInput
}) {
	const input = yield* decodeInput(GetErrorsSparkInputSchema, data ?? {}, "getErrorsSpark")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)

	// No fingerprints means nothing to chart — skipping the round-trip matters
	// here because the list renders before its issues have loaded.
	if (input.fingerprintHashes.length === 0) return { data: [] as ErrorsSparkSeries[] }

	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const scope = yield* scopeServicesToNamespaces({
		namespaces: input.namespaces,
		services: input.services,
		startTime,
		endTime,
	})
	if (scope.empty) return { data: [] as ErrorsSparkSeries[] }

	const result = yield* runWarehouseQuery("errorsSpark", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.errorsSpark({
				payload: new ErrorsSparkRequest({
					startTime,
					endTime,
					fingerprintHashes: input.fingerprintHashes,
					services: scope.services,
					deploymentEnvs: input.deploymentEnvs,
					errorLabels: input.errorLabels,
					serviceVersions: input.serviceVersions,
					excludedServices: input.excludedServices,
					excludedDeploymentEnvs: input.excludedDeploymentEnvs,
					excludedErrorLabels: input.excludedErrorLabels,
					excludedServiceVersions: input.excludedServiceVersions,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)

	const byFingerprint = new Map<string, ErrorsTimeseriesItem[]>()
	for (const raw of result.data) {
		const hash = String(raw.fingerprintHash)
		const points = byFingerprint.get(hash)
		const point = { bucket: String(raw.bucket), count: Number(raw.count) }
		if (points) points.push(point)
		else byFingerprint.set(hash, [point])
	}

	return {
		data: [...byFingerprint].map(([fingerprintHash, points]) => ({ fingerprintHash, points })),
	}
})
