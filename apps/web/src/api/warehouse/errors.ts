import { Clock, Effect, Schema } from "effect"
import {
	QueryEngineExecuteRequest,
	warehouseDateTimeToIso,
	formatWarehouseDateTime,
} from "@maple/query-engine"
import {
	DeploymentEnvironment,
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ErrorDetailTracesRequest,
	ErrorsTimeseriesRequest,
	FingerprintHash,
	ServiceName,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
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
	fingerprintHashes: OptionalFingerprintHashArray,
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

	const result = yield* runWarehouseQuery("errorsByType", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsByType({
				payload: new ErrorsByTypeRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
					limit: input.limit,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			fingerprintHash: raw.fingerprintHash,
			errorLabel: raw.errorLabel,
			sampleMessage: raw.sampleMessage,
			count: Number(raw.count),
			affectedServicesCount: Number(raw.affectedServicesCount),
			firstSeen: new Date(warehouseDateTimeToIso(raw.firstSeen)),
			lastSeen: new Date(warehouseDateTimeToIso(raw.lastSeen)),
		})),
	}
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
	fingerprintHashes: OptionalFingerprintHashArray,
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

	const response = yield* executeQueryEngine(
		"queryEngine.getErrorsFacets",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "facets" as const,
				source: "errors" as const,
				filters: {
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
				},
			},
		}),
	)

	const facetsData = extractFacets(response)
	const services: FacetItem[] = []
	const deploymentEnvs: FacetItem[] = []
	const errorTypes: FacetItem[] = []

	for (const row of facetsData) {
		const item = { name: row.name, count: Number(row.count) }
		switch (row.facetType) {
			case "service":
				services.push(item)
				break
			case "deploymentEnv":
				deploymentEnvs.push(item)
				break
			case "errorType":
				errorTypes.push(item)
				break
		}
	}

	return {
		data: { services, deploymentEnvs, errorTypes },
	}
})

const GetErrorsSummaryInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	deploymentEnvs: OptionalDeploymentEnvArray,
	fingerprintHashes: OptionalFingerprintHashArray,
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

	const result = yield* runWarehouseQuery("errorsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsSummary({
				payload: new ErrorsSummaryRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
				}),
			})
		}),
	)

	const summary = result.data
	return {
		data: summary
			? {
					totalErrors: Number(summary.totalErrors),
					totalSpans: Number(summary.totalSpans),
					errorRate: Number(summary.errorRate),
					affectedServicesCount: Number(summary.affectedServicesCount),
					affectedTracesCount: Number(summary.affectedTracesCount),
				}
			: null,
	}
})

export interface ErrorDetailTrace {
	traceId: string
	startTime: Date
	durationMicros: number
	spanCount: number
	services: string[]
	rootSpanName: string
	errorMessage: string
}

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
			const client = yield* MapleApiAtomClient
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

const GetErrorsTimeseriesInputSchema = Schema.Struct({
	fingerprintHash: FingerprintHash,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalServiceArray,
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
})

export type GetErrorsTimeseriesInput = (typeof GetErrorsTimeseriesInputSchema)["Encoded"]

export function getErrorsTimeseries({ data }: { data: GetErrorsTimeseriesInput }) {
	return getErrorsTimeseriesEffect({ data })
}

const getErrorsTimeseriesEffect = Effect.fn("QueryEngine.getErrorsTimeseries")(function* ({
	data,
}: {
	data: GetErrorsTimeseriesInput
}) {
	const input = yield* decodeInput(GetErrorsTimeseriesInputSchema, data ?? {}, "getErrorsTimeseries")
	const fallback = defaultErrorsTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("errorsTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsTimeseries({
				payload: new ErrorsTimeseriesRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					fingerprintHash: input.fingerprintHash,
					services: input.services,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			bucket: String(raw.bucket),
			count: Number(raw.count),
		})),
	}
})
