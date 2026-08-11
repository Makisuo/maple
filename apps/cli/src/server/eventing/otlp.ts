import { createHash } from "node:crypto"
import {
	canonicalJson,
	defineSignalFields,
	type JsonValue,
	type NormalizedSignal,
	type SignalFieldCatalogEntry,
	type SignalScalar,
	type SignalSourceAdapter,
	type SignalSourceDefinition,
} from "@maple/eventing-core"
import { OtlpFieldError, spanIdHex, traceIdHex } from "../otlp/encode"

interface AnyValue {
	readonly stringValue?: string
	readonly boolValue?: boolean
	readonly intValue?: string | number
	readonly doubleValue?: number
	readonly bytesValue?: string
	readonly arrayValue?: { readonly values?: readonly AnyValue[] }
	readonly kvlistValue?: { readonly values?: readonly KeyValue[] }
}

interface KeyValue {
	readonly key?: string
	readonly value?: AnyValue
}

interface OtlpLogsRequest {
	readonly resourceLogs?: readonly {
		readonly resource?: { readonly attributes?: readonly KeyValue[] }
		readonly scopeLogs?: readonly {
			readonly scope?: {
				readonly name?: string
				readonly version?: string
				readonly attributes?: readonly KeyValue[]
			}
			readonly logRecords?: readonly {
				readonly timeUnixNano?: string | number
				readonly observedTimeUnixNano?: string | number
				readonly severityNumber?: number
				readonly severityText?: string
				readonly eventName?: string
				readonly body?: AnyValue
				readonly attributes?: readonly KeyValue[]
				readonly traceId?: string
				readonly spanId?: string
			}[]
		}[]
	}[]
}

const MAX_ATTRIBUTES = 256
const MAX_STRING_BYTES = 16 * 1024
const MAX_DATA_BYTES = 256 * 1024
const MAX_VALUE_DEPTH = 8
const MAX_VALUE_NODES = 1_024
const SENSITIVE_KEY =
	/(?:^|[._-])(authorization|cookie|password|passwd|secret|token|api[._-]?key)(?:$|[._-])/i

const allOperators = ["exists", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"] as const
const equalityOperators = ["exists", "eq", "neq", "contains", "in"] as const

const catalog = (
	key: string,
	type: SignalScalar["type"],
	operators: SignalFieldCatalogEntry["operators"] = allOperators,
): SignalFieldCatalogEntry => ({
	field: { namespace: "signal", key, type },
	operators,
	sensitivity: "public",
	replay: "exact",
})

export const OTLP_LOG_SOURCE: SignalSourceDefinition = {
	sourceKind: "otel.log",
	fields: [
		catalog("event.name", "string", equalityOperators),
		catalog("severity.number", "int64"),
		catalog("severity.text", "string", equalityOperators),
		catalog("trace.id", "string", equalityOperators),
		catalog("span.id", "string", equalityOperators),
		catalog("time", "timestamp"),
		catalog("observed_time", "timestamp"),
		{
			field: { namespace: "body", key: "value" },
			types: ["string", "boolean", "int64", "float64"],
			operators: allOperators,
			sensitivity: "public",
			replay: "coerced",
		},
	],
	openFields: [
		{
			namespace: "resource",
			types: ["string", "boolean", "int64", "float64"],
			operators: allOperators,
			sensitivity: "public",
			replay: "coerced",
		},
		{
			namespace: "scope",
			types: ["string", "boolean", "int64", "float64"],
			operators: allOperators,
			sensitivity: "public",
			replay: "coerced",
		},
		{
			namespace: "attribute",
			types: ["string", "boolean", "int64", "float64"],
			operators: allOperators,
			sensitivity: "public",
			replay: "coerced",
		},
	],
}

interface ValueBudget {
	nodes: number
}

const assertStringBound = (value: string, label: string): string => {
	if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES)
		throw new OtlpFieldError(`${label} exceeds ${MAX_STRING_BYTES} UTF-8 bytes`)
	return value
}

const int64 = (value: string | number, label: string): string => {
	if (typeof value === "number" && !Number.isSafeInteger(value))
		throw new OtlpFieldError(
			`${label} must encode int64 as a decimal string when outside safe integer range`,
		)
	const decimal = String(value)
	if (!/^-?(?:0|[1-9][0-9]*)$/.test(decimal)) throw new OtlpFieldError(`${label} is not an int64`)
	const parsed = BigInt(decimal)
	if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n)
		throw new OtlpFieldError(`${label} is outside the int64 range`)
	return decimal
}

const anyValueScalar = (value: AnyValue | undefined, label: string): SignalScalar | null => {
	if (!value) return null
	if (value.stringValue !== undefined)
		return { type: "string", value: assertStringBound(value.stringValue, label) }
	if (value.boolValue !== undefined) return { type: "boolean", value: value.boolValue }
	if (value.intValue !== undefined) return { type: "int64", value: int64(value.intValue, label) }
	if (value.doubleValue !== undefined) {
		if (!Number.isFinite(value.doubleValue)) throw new OtlpFieldError(`${label} must be finite`)
		return { type: "float64", value: value.doubleValue }
	}
	return null
}

const anyValueJson = (
	value: AnyValue | undefined,
	label: string,
	depth = 0,
	budget: ValueBudget = { nodes: 0 },
): JsonValue | null => {
	budget.nodes += 1
	if (budget.nodes > MAX_VALUE_NODES) throw new OtlpFieldError(`${label} exceeds value node limit`)
	if (depth > MAX_VALUE_DEPTH) throw new OtlpFieldError(`${label} exceeds value depth limit`)
	const scalar = anyValueScalar(value, label)
	if (scalar) return scalar.value
	if (!value) return null
	if (value.bytesValue !== undefined) return assertStringBound(value.bytesValue, `${label}.bytesValue`)
	if (value.arrayValue !== undefined)
		return (value.arrayValue.values ?? []).map((item, index) =>
			anyValueJson(item, `${label}[${index}]`, depth + 1, budget),
		)
	if (value.kvlistValue !== undefined) {
		const output: Record<string, JsonValue> = {}
		for (const [index, entry] of (value.kvlistValue.values ?? []).entries()) {
			const key = assertStringBound(entry.key ?? "", `${label}.key[${index}]`)
			if (key.length === 0 || SENSITIVE_KEY.test(key)) continue
			output[key] = anyValueJson(entry.value, `${label}.${key}`, depth + 1, budget)
		}
		return output
	}
	return null
}

interface NormalizedAttributes {
	readonly scalars: ReadonlyArray<{ readonly key: string; readonly value: SignalScalar }>
	readonly data: Readonly<Record<string, JsonValue>>
}

const attributes = (values: readonly KeyValue[] | undefined, label: string): NormalizedAttributes => {
	if ((values?.length ?? 0) > MAX_ATTRIBUTES)
		throw new OtlpFieldError(`${label} exceeds ${MAX_ATTRIBUTES} attributes`)
	const scalars = new Map<string, SignalScalar>()
	const data: Record<string, JsonValue> = {}
	for (const [index, entry] of (values ?? []).entries()) {
		const key = assertStringBound(entry.key ?? "", `${label}[${index}].key`)
		if (key.length === 0 || SENSITIVE_KEY.test(key)) continue
		const scalar = anyValueScalar(entry.value, `${label}.${key}`)
		if (scalar) scalars.set(key, scalar)
		data[key] = anyValueJson(entry.value, `${label}.${key}`)
	}
	return { scalars: [...scalars].map(([key, value]) => ({ key, value })), data }
}

const epochNanos = (value: string | number | undefined): bigint | null => {
	if (value === undefined || value === "" || value === 0 || value === "0") return null
	try {
		const parsed = BigInt(value)
		return parsed >= 0 ? parsed : null
	} catch {
		return null
	}
}

const nanosToTimestamp = (nanos: bigint): string => {
	const seconds = nanos / 1_000_000_000n
	const fraction = nanos % 1_000_000_000n
	const milliseconds = Number(seconds) * 1_000
	const date = new Date(milliseconds)
	if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime()))
		throw new OtlpFieldError("OTLP timestamp is outside the supported date range")
	return `${date.toISOString().slice(0, 19)}.${fraction.toString().padStart(9, "0")}Z`
}

const stringAttribute = (attrs: NormalizedAttributes, key: string): string | null => {
	const scalar = attrs.scalars.find((entry) => entry.key === key)?.value
	return scalar?.type === "string" ? scalar.value : null
}

const boundedIdentity = (value: string, prefix: string): string =>
	value.length <= 256
		? value
		: `${prefix}:sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`

const sourceUri = (resource: NormalizedAttributes, record: NormalizedAttributes): string => {
	const explicit = (
		stringAttribute(record, "event.source") ?? stringAttribute(record, "cloudevents.source")
	)?.trim()
	if (explicit) return boundedIdentity(assertStringBound(explicit, "event source"), "urn:maple:source")
	const service = stringAttribute(resource, "service.name")?.trim()
	const source = service
		? `urn:maple:source:otel:${encodeURIComponent(service)}`
		: "urn:maple:source:otel:local"
	return boundedIdentity(source, "urn:maple:source")
}

const sourceOccurrenceId = (record: NormalizedAttributes): string | null => {
	for (const key of ["event.id", "cloudevents.id", "gitlab.event.id"]) {
		const value = stringAttribute(record, key)?.trim()
		if (value) return boundedIdentity(value, "source")
	}
	return null
}

const derivedOccurrenceId = (input: JsonValue): string =>
	`derived:sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`

export const normalizeOtlpLogs = (
	request: unknown,
	acceptedAt = new Date().toISOString(),
	tenantId = "local",
): readonly NormalizedSignal[] => {
	const input = (request ?? {}) as OtlpLogsRequest
	const signals: NormalizedSignal[] = []
	for (const resourceLogs of input.resourceLogs ?? []) {
		const resource = attributes(resourceLogs.resource?.attributes, "resource.attributes")
		for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
			const scope = attributes(scopeLogs.scope?.attributes, "scope.attributes")
			for (const log of scopeLogs.logRecords ?? []) {
				const record = attributes(log.attributes, "log.attributes")
				const occurredNanos = epochNanos(log.timeUnixNano) ?? epochNanos(log.observedTimeUnixNano)
				const observedNanos = epochNanos(log.observedTimeUnixNano)
				const occurredAt = occurredNanos ? nanosToTimestamp(occurredNanos) : acceptedAt
				const sourceObservedAt = observedNanos ? nanosToTimestamp(observedNanos) : acceptedAt
				const bodyScalar = anyValueScalar(log.body, "log.body")
				const traceId = traceIdHex(log.traceId, "logRecord.traceId")
				const spanId = spanIdHex(log.spanId, "logRecord.spanId")
				const data: JsonValue = {
					resource: resource.data,
					scope: {
						name: assertStringBound(scopeLogs.scope?.name ?? "", "scope.name"),
						version: assertStringBound(scopeLogs.scope?.version ?? "", "scope.version"),
						attributes: scope.data,
					},
					record: {
						eventName: assertStringBound(log.eventName ?? "", "log.eventName"),
						severityNumber: log.severityNumber ?? 0,
						severityText: assertStringBound(log.severityText ?? "", "log.severityText"),
						traceId,
						spanId,
						body: anyValueJson(log.body, "log.body"),
						attributes: record.data,
					},
				}
				if (Buffer.byteLength(canonicalJson(data), "utf8") > MAX_DATA_BYTES)
					throw new OtlpFieldError(`normalized log event exceeds ${MAX_DATA_BYTES} UTF-8 bytes`)
				const source = sourceUri(resource, record)
				const occurrenceId = sourceOccurrenceId(record)
				const subject =
					stringAttribute(record, "event.subject") ?? stringAttribute(record, "cloudevents.subject")
				signals.push({
					sourceKind: "otel.log",
					source,
					tenantId,
					occurrenceId:
						occurrenceId ??
						derivedOccurrenceId({ source, occurredAt, signalKind: "otel.log", data }),
					identityQuality: occurrenceId === null ? "derived" : "source",
					occurredAt,
					observedAt: acceptedAt,
					subject,
					fields: defineSignalFields([
						...(log.eventName
							? [
									{
										field: {
											namespace: "signal" as const,
											key: "event.name",
											type: "string" as const,
										},
										value: { type: "string" as const, value: log.eventName },
									},
								]
							: []),
						{
							field: { namespace: "signal", key: "severity.number", type: "int64" },
							value: {
								type: "int64",
								value: int64(log.severityNumber ?? 0, "severity.number"),
							},
						},
						...(log.severityText
							? [
									{
										field: {
											namespace: "signal" as const,
											key: "severity.text",
											type: "string" as const,
										},
										value: { type: "string" as const, value: log.severityText },
									},
								]
							: []),
						...(traceId
							? [
									{
										field: {
											namespace: "signal" as const,
											key: "trace.id",
											type: "string" as const,
										},
										value: { type: "string" as const, value: traceId },
									},
								]
							: []),
						...(spanId
							? [
									{
										field: {
											namespace: "signal" as const,
											key: "span.id",
											type: "string" as const,
										},
										value: { type: "string" as const, value: spanId },
									},
								]
							: []),
						{
							field: { namespace: "signal", key: "time", type: "timestamp" },
							value: { type: "timestamp", value: occurredAt },
						},
						{
							field: { namespace: "signal", key: "observed_time", type: "timestamp" },
							value: { type: "timestamp", value: sourceObservedAt },
						},
						...resource.scalars.map(({ key, value }) => ({
							field: { namespace: "resource" as const, key, type: value.type },
							value,
						})),
						...scope.scalars.map(({ key, value }) => ({
							field: { namespace: "scope" as const, key, type: value.type },
							value,
						})),
						...record.scalars.map(({ key, value }) => ({
							field: { namespace: "attribute" as const, key, type: value.type },
							value,
						})),
						...(bodyScalar
							? [
									{
										field: {
											namespace: "body" as const,
											key: "value",
											type: bodyScalar.type,
										},
										value: bodyScalar,
									},
								]
							: []),
					]),
					data,
				})
			}
		}
	}
	return signals
}

export const OTLP_LOG_ADAPTER: SignalSourceAdapter<
	unknown,
	{ readonly acceptedAt: string; readonly tenantId: string }
> = {
	definition: OTLP_LOG_SOURCE,
	normalize: (raw, context) => normalizeOtlpLogs(raw, context.acceptedAt, context.tenantId),
}
