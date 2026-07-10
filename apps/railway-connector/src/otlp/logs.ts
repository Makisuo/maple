/**
 * Converts Railway `environmentLogs` subscription entries into an OTLP/JSON
 * `ExportLogsServiceRequest` for the Maple ingest gateway (`POST /v1/logs`).
 */
import {
	attribute,
	buildResourceAttributes,
	msToUnixNano,
	type OtlpKeyValue,
	type RailwayResourceContext,
} from "./common"

/** A tolerant parse of one Railway log entry (see decodeRailwayLogEntry). */
export interface RailwayLogEntry {
	/** Epoch milliseconds. */
	readonly timestampMs: number
	readonly message: string
	/** Railway's severity string (`info`, `warn`, `error`, …) or null. */
	readonly severity: string | null
	/** Railway service the line came from; null for environment-level entries. */
	readonly serviceId: string | null
	readonly deploymentId: string | null
	/** Structured attributes Railway extracted from the line. */
	readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

export interface OtlpLogRecord {
	readonly timeUnixNano: string
	readonly observedTimeUnixNano: string
	readonly severityNumber: number
	readonly severityText: string
	readonly body: { readonly stringValue: string }
	readonly attributes: ReadonlyArray<OtlpKeyValue>
}

export interface OtlpLogsExportRequest {
	readonly resourceLogs: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeLogs: ReadonlyArray<{
			readonly scope: { readonly name: string }
			readonly logRecords: ReadonlyArray<OtlpLogRecord>
		}>
	}>
}

const SCOPE_NAME = "railway.environment_logs"

/**
 * OTLP severity numbers (spec: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN,
 * 17-20 ERROR, 21-24 FATAL; 0 unspecified).
 */
export const severityNumberFor = (severity: string | null): number => {
	if (severity === null) return 0
	switch (severity.toLowerCase()) {
		case "trace":
			return 1
		case "debug":
			return 5
		case "info":
			return 9
		case "warn":
		case "warning":
			return 13
		case "err":
		case "error":
			return 17
		case "fatal":
		case "critical":
			return 21
		default:
			return 0
	}
}

/**
 * Tolerant decode of a subscription `next` payload entry. Railway's schema
 * carries `timestamp` (RFC3339), `message`, `severity`, `tags { serviceId,
 * deploymentId, … }`, and `attributes [{ key, value }]`; anything missing
 * degrades instead of dropping the line (only an unparseable timestamp or a
 * missing message discards it).
 */
export const decodeRailwayLogEntry = (raw: unknown): RailwayLogEntry | null => {
	if (typeof raw !== "object" || raw === null) return null
	const entry = raw as Record<string, unknown>

	const message = typeof entry.message === "string" ? entry.message : null
	if (message === null) return null

	const timestampMs =
		typeof entry.timestamp === "string"
			? Date.parse(entry.timestamp)
			: typeof entry.timestamp === "number"
				? entry.timestamp
				: Number.NaN
	if (!Number.isFinite(timestampMs)) return null

	const tags =
		typeof entry.tags === "object" && entry.tags !== null ? (entry.tags as Record<string, unknown>) : {}

	const attributes: Array<{ key: string; value: string }> = []
	if (Array.isArray(entry.attributes)) {
		for (const item of entry.attributes) {
			if (typeof item !== "object" || item === null) continue
			const pair = item as Record<string, unknown>
			if (typeof pair.key === "string" && typeof pair.value === "string") {
				attributes.push({ key: pair.key, value: pair.value })
			}
		}
	}

	return {
		timestampMs,
		message,
		severity: typeof entry.severity === "string" ? entry.severity : null,
		serviceId: typeof tags.serviceId === "string" ? tags.serviceId : null,
		deploymentId: typeof tags.deploymentId === "string" ? tags.deploymentId : null,
		attributes,
	}
}

export const buildLogRecord = (entry: RailwayLogEntry, observedAtMs: number): OtlpLogRecord => ({
	timeUnixNano: msToUnixNano(entry.timestampMs),
	observedTimeUnixNano: msToUnixNano(observedAtMs),
	severityNumber: severityNumberFor(entry.severity),
	severityText: entry.severity ?? "",
	body: { stringValue: entry.message },
	attributes: [
		...(entry.deploymentId === null ? [] : [attribute("railway.deployment.id", entry.deploymentId)]),
		...entry.attributes.map((pair) => attribute(pair.key, pair.value)),
	],
})

export interface LogBatchContext {
	readonly projectId: string
	readonly projectName: string | null
	readonly environmentId: string
	readonly environmentName: string | null
	/** Environment services (id → name) for per-service resource attribution. */
	readonly services: ReadonlyArray<{ readonly id: string; readonly name: string }>
	readonly observedAtMs: number
}

/**
 * Group a batch of entries into one export request with one resource per
 * Railway service. Entries with no/unknown serviceId attribute to a synthetic
 * environment-level service so nothing is silently dropped; unknown service
 * ids degrade to `railway:<id>` until the next discovery refresh names them.
 */
export const buildLogsExportRequest = (
	entries: ReadonlyArray<RailwayLogEntry>,
	context: LogBatchContext,
): OtlpLogsExportRequest | null => {
	if (entries.length === 0) return null

	const nameByServiceId = new Map(context.services.map((service) => [service.id, service.name]))
	const byServiceId = new Map<string, RailwayLogEntry[]>()
	for (const entry of entries) {
		const key = entry.serviceId ?? ""
		const bucket = byServiceId.get(key)
		if (bucket === undefined) byServiceId.set(key, [entry])
		else bucket.push(entry)
	}

	const environmentLabel = context.environmentName ?? context.environmentId

	return {
		resourceLogs: [...byServiceId.entries()].map(([serviceId, serviceEntries]) => {
			const resourceContext: RailwayResourceContext = {
				serviceName:
					serviceId === ""
						? `railway-environment:${environmentLabel}`
						: (nameByServiceId.get(serviceId) ?? `railway:${serviceId}`),
				serviceId: serviceId === "" ? "environment" : serviceId,
				projectId: context.projectId,
				projectName: context.projectName,
				environmentId: context.environmentId,
				environmentName: context.environmentName,
			}
			return {
				resource: { attributes: buildResourceAttributes(resourceContext) },
				scopeLogs: [
					{
						scope: { name: SCOPE_NAME },
						logRecords: serviceEntries.map((entry) => buildLogRecord(entry, context.observedAtMs)),
					},
				],
			}
		}),
	}
}
