import { deepStrictEqual, ok, strictEqual, throws } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import {
	fieldKey,
	isJsonValue,
	ProjectorRegistry,
	type JsonValue,
	type NormalizedSignal,
	type SignalProjectionSpec,
	type SignalScalar,
} from "@maple/eventing-core"
import { LocalEventingControlStore } from "../src/server/eventing/control-store"
import { normalizeOtlpLogs, normalizeOtlpLogsWithDiagnostics } from "../src/server/eventing/otlp"
import { LocalEventingRuntime, sourceOccurrenceFingerprint } from "../src/server/eventing/runtime"
import type { EventingTelemetryObservation } from "../src/server/eventing/telemetry"
import { encodeLogs } from "../src/server/otlp/encode"

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-eventing-runtime-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const attr = (key: string, value: Record<string, unknown>) => ({ key, value })

const exampleRecordObserved = {
	resourceLogs: [
		{
			resource: {
				attributes: [
					attr("service.name", { stringValue: "example-service" }),
					attr("service.version", { stringValue: "19.1.0" }),
				],
			},
			scopeLogs: [
				{
					scope: { name: "example.event_store", version: "1.0.0" },
					logRecords: [
						{
							timeUnixNano: "1786131720123456789",
							observedTimeUnixNano: "1786131721123456789",
							eventName: "example.record.observed",
							severityNumber: 9,
							severityText: "INFO",
							body: { stringValue: "Record 42 observed" },
							attributes: [
								attr("event.id", { stringValue: "01K20EXAMPLERECORD42" }),
								attr("event.source", { stringValue: "https://events.example.test" }),
								attr("example.collection.id", { intValue: "7" }),
								attr("example.collection.name", { stringValue: "example/widgets" }),
								attr("example.record.id", { intValue: "4200" }),
								attr("example.record.sequence", { intValue: "42" }),
								attr("example.record.title", { stringValue: "Observe example events" }),
								attr("example.record.url", {
									stringValue: "https://events.example.test/collections/widgets/records/42",
								}),
								attr("example.actor.id", { intValue: "9" }),
								attr("example.actor.name", { stringValue: "observer" }),
							],
						},
					],
				},
			],
		},
	],
}

const firstLogRecord = (request: typeof exampleRecordObserved) =>
	request.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "example-record-observed",
	revision: 1,
	enabled: true,
	tenantId: "local",
	sourceKind: "otel.log",
	selector: {
		op: "all",
		clauses: [
			{
				op: "eq",
				field: { namespace: "signal", key: "event.name", type: "string" },
				value: { type: "string", value: "example.record.observed" },
			},
			{
				op: "gte",
				field: { namespace: "attribute", key: "example.record.sequence", type: "int64" },
				value: { type: "int64", value: "1" },
			},
		],
	},
	projector: { id: "example.record.observed", version: 1, config: {} },
	activeFrom: "2000-01-01T00:00:00Z",
	...overrides,
})

const signalField = (
	signal: NormalizedSignal,
	namespace: "resource" | "attribute",
	key: string,
): SignalScalar | undefined => signal.fields.get(fieldKey({ namespace, key }))

const stringField = (
	signal: NormalizedSignal,
	namespace: "resource" | "attribute",
	key: string,
	required = false,
): string | undefined => {
	const value = signalField(signal, namespace, key)
	if (value === undefined) {
		if (required) throw new Error(`example event is missing ${key}`)
		return undefined
	}
	if (value.type !== "string") throw new Error(`example event ${key} must be a string`)
	return value.value
}

const int64Field = (signal: NormalizedSignal, key: string, required = false): string | undefined => {
	const value = signalField(signal, "attribute", key)
	if (value === undefined) {
		if (required) throw new Error(`example event is missing ${key}`)
		return undefined
	}
	if (value.type !== "int64") throw new Error(`example event ${key} must be an int64`)
	return value.value
}

const exampleProjectors = (): ProjectorRegistry =>
	new ProjectorRegistry().register({
		id: "example.record.observed",
		version: 1,
		sourceKinds: ["otel.log"],
		outputType: "dev.maple.example.record.observed.v1",
		dataSchema: "urn:maple:event-schema:example-record-observed:v1",
		decodeOutput: (value): JsonValue => {
			if (!isJsonValue(value)) throw new Error("example projector output must be finite JSON")
			return value
		},
		decodeConfig: (value) => {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new Error("example projector config must be an object")
			return {}
		},
		project: (signal) => {
			const collectionName = stringField(signal, "attribute", "example.collection.name", true)!
			const sequence = int64Field(signal, "example.record.sequence", true)!
			return {
				subject: `${collectionName}/records/${sequence}`,
				data: {
					collection: {
						id: int64Field(signal, "example.collection.id"),
						name: collectionName,
					},
					record: {
						id: int64Field(signal, "example.record.id"),
						sequence,
						title: stringField(signal, "attribute", "example.record.title"),
						url: stringField(signal, "attribute", "example.record.url"),
					},
					actor: {
						id: int64Field(signal, "example.actor.id"),
						name: stringField(signal, "attribute", "example.actor.name"),
					},
					serviceName: stringField(signal, "resource", "service.name"),
				},
			}
		},
	})

describe("LocalEventingRuntime", () => {
	it("records bounded normalization and projection outcomes without signal data", async () =>
		withDataDir(async (dataDir) => {
			const observations: EventingTelemetryObservation[] = []
			const telemetry = {
				record: (observation: EventingTelemetryObservation) => observations.push(observation),
			}
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store, telemetry, exampleProjectors())
				runtime.activate(projection())
				strictEqual(runtime.evaluateOtlp("logs", exampleRecordObserved).events.length, 1)

				const malformed = structuredClone(exampleRecordObserved)
				firstLogRecord(malformed).attributes = firstLogRecord(malformed).attributes.filter(
					({ key }) => key !== "example.collection.name",
				)
				strictEqual(runtime.evaluateOtlp("logs", malformed).failures.length, 1)

				const mismatched = structuredClone(exampleRecordObserved)
				firstLogRecord(mismatched).attributes = firstLogRecord(mismatched).attributes.map((entry) =>
					entry.key === "example.record.sequence" ? attr(entry.key, { stringValue: "42" }) : entry,
				)
				deepStrictEqual(runtime.evaluateOtlp("logs", mismatched).typeMismatchFields, [
					"attribute:example.record.sequence",
				])

				const projectionBoundFailure = structuredClone(exampleRecordObserved)
				firstLogRecord(projectionBoundFailure).attributes.push(
					...Array.from({ length: 257 }, (_, index) =>
						attr(`projection-only-${index}`, { stringValue: "warehouse-valid" }),
					),
				)
				strictEqual(runtime.evaluateOtlp("logs", projectionBoundFailure).events.length, 0)

				const operationOutcomes = observations.map(
					({ operation, outcome }) => `${operation}:${outcome}`,
				)
				ok(operationOutcomes.includes("normalization:success"))
				ok(operationOutcomes.includes("normalization:failure"))
				ok(operationOutcomes.includes("projection:success"))
				ok(operationOutcomes.includes("projection:failure"))
				ok(operationOutcomes.includes("selector_type_mismatch:observed"))
				const serialized = JSON.stringify(observations)
				strictEqual(serialized.includes("Observe example events"), false)
				strictEqual(serialized.includes("01K20EXAMPLERECORD42"), false)
				strictEqual(serialized.includes("example-record-observed"), false)
				strictEqual(serialized.includes("example.record.sequence"), false)
			} finally {
				store.close()
			}
		}))

	it("normalizes typed generic OTLP fields while preserving the existing warehouse encoding", () => {
		const [signal] = normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z")
		strictEqual(signal?.occurrenceId, "01K20EXAMPLERECORD42")
		strictEqual(signal?.identityQuality, "source")
		strictEqual(signal?.source, "https://events.example.test")
		deepStrictEqual(signal?.fields.get("attribute:example.record.sequence"), {
			type: "int64",
			value: "42",
		})
		const batches = encodeLogs(exampleRecordObserved)
		strictEqual(batches.length, 1)
		strictEqual(batches[0]?.rowCount, 1)
		strictEqual(JSON.parse(batches[0]!.ndjson).log_attributes["example.record.sequence"], "42")
	})

	it("uses the first nonblank occurrence alias and derives identity when every alias is blank", () => {
		const aliased = structuredClone(exampleRecordObserved)
		const aliasedRecord = firstLogRecord(aliased)
		aliasedRecord.attributes = [
			attr("event.id", { stringValue: "   " }),
			attr("cloudevents.id", { stringValue: " cloud-event-42 " }),
			...aliasedRecord.attributes.filter(({ key }) => !["event.id", "cloudevents.id"].includes(key)),
		]
		const [aliasedSignal] = normalizeOtlpLogs(aliased, "2026-08-07T20:00:00Z")
		strictEqual(aliasedSignal?.occurrenceId, "cloud-event-42")
		strictEqual(aliasedSignal?.identityQuality, "source")

		const derivedA = structuredClone(aliased)
		const derivedARecord = firstLogRecord(derivedA)
		derivedARecord.attributes = derivedARecord.attributes.map((entry) =>
			["event.id", "cloudevents.id"].includes(entry.key)
				? attr(entry.key, { stringValue: entry.key === "event.id" ? "" : " \t " })
				: entry,
		)
		const derivedB = structuredClone(derivedA)
		firstLogRecord(derivedB).body = { stringValue: "A different record occurrence" }
		const [signalA] = normalizeOtlpLogs(derivedA, "2026-08-07T20:00:00Z")
		const [signalB] = normalizeOtlpLogs(derivedB, "2026-08-07T20:00:00Z")
		strictEqual(signalA?.identityQuality, "derived")
		strictEqual(signalB?.identityQuality, "derived")
		strictEqual(signalA?.occurrenceId?.startsWith("derived:sha256:"), true)
		strictEqual(signalA?.occurrenceId === signalB?.occurrenceId, false)
	})

	it("keeps projectable retries byte-identical and skips timestamp-less durable logs", () => {
		const first = normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z")
		const retry = normalizeOtlpLogs(exampleRecordObserved, "2026-08-08T20:00:00Z")
		deepStrictEqual(first, retry)

		const timestampLess = structuredClone(exampleRecordObserved)
		const timestampLessRecord = firstLogRecord(timestampLess) as {
			timeUnixNano?: string
			observedTimeUnixNano?: string
		}
		delete timestampLessRecord.timeUnixNano
		delete timestampLessRecord.observedTimeUnixNano
		deepStrictEqual(normalizeOtlpLogs(timestampLess, "2026-08-07T20:00:00Z"), [])
		deepStrictEqual(
			normalizeOtlpLogsWithDiagnostics(timestampLess, "2026-08-07T20:00:00Z").unprojectedIdentities,
			[
				{
					sourceKind: "otel.log",
					source: "https://events.example.test",
					tenantId: "local",
					occurrenceId: "01K20EXAMPLERECORD42",
					occurredAt: null,
				},
			],
		)
	})

	it("uses a locale-independent source-fingerprint field order", () => {
		const [signal] = normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z")
		const fields = new Map(signal!.fields)
		fields.set("attribute:ä", { type: "string", value: "umlaut" })
		fields.set("attribute:z", { type: "string", value: "ascii" })
		const forward = { ...signal!, fields }
		const reverse = { ...signal!, fields: new Map([...fields].reverse()) }
		strictEqual(sourceOccurrenceFingerprint(forward), sourceOccurrenceFingerprint(reverse))
		strictEqual(
			sourceOccurrenceFingerprint(forward),
			"sha256:4ed4d210645f2df1959e5c56acb5b22140a01aa267fdf1fab8b62e56ea63e31e",
		)
	})

	it("preserves __proto__ as ordinary OTLP data without prototype mutation", () => {
		const request = structuredClone(exampleRecordObserved)
		firstLogRecord(request).attributes.push(
			attr("__proto__", {
				kvlistValue: { values: [attr("nested", { stringValue: "top-level" })] },
			}),
			attr("safe", {
				kvlistValue: { values: [attr("__proto__", { stringValue: "nested" })] },
			}),
		)
		const [signal] = normalizeOtlpLogs(request, "2026-08-07T20:00:00Z")
		const record = (signal!.data as { record: { attributes: Record<string, JsonValue> } }).record
		ok(Object.prototype.hasOwnProperty.call(record.attributes, "__proto__"))
		deepStrictEqual(record.attributes["__proto__"], { nested: "top-level" })
		const safe = record.attributes.safe as Record<string, JsonValue>
		ok(Object.prototype.hasOwnProperty.call(safe, "__proto__"))
		strictEqual(safe["__proto__"], "nested")
		strictEqual(Object.prototype.hasOwnProperty.call({}, "nested"), false)
	})

	it("catalogs only the scalar body field that the OTLP adapter can populate", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store, undefined, exampleProjectors())
				throws(
					() =>
						runtime.prepareActivation(
							projection({
								selector: {
									op: "exists",
									field: { namespace: "body", key: "text", type: "string" },
								},
							}),
						),
					/unknown field body:text/,
				)
				const activation = runtime.prepareActivation(
					projection({
						selector: {
							op: "exists",
							field: { namespace: "body", key: "value", type: "boolean" },
						},
					}),
				)
				strictEqual(activation.spec.selector.op, "exists")
			} finally {
				store.close()
			}
		}))

	it("projects before storage, deduplicates retry delivery, and makes the event ready after commit", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store, undefined, exampleProjectors())
				strictEqual(runtime.hasActiveSource("otel.log"), false)
				runtime.activate(projection())
				const first = runtime.evaluateOtlp("logs", exampleRecordObserved)
				strictEqual(first.failures.length, 0)
				strictEqual(first.events.length, 1)
				deepStrictEqual(first.events[0], {
					specversion: "1.0",
					id: first.events[0]!.id,
					source: "https://events.example.test",
					type: "dev.maple.example.record.observed.v1",
					subject: "example/widgets/records/42",
					time: "2026-08-07T19:42:00.123456789Z",
					datacontenttype: "application/json",
					dataschema: "urn:maple:event-schema:example-record-observed:v1",
					tenantid: "local",
					projectionid: "example-record-observed",
					projectionrevision: 1,
					projectorid: "example.record.observed",
					projectorversion: 1,
					sourceoccurrenceid: "01K20EXAMPLERECORD42",
					sourceidentityquality: "source",
					data: {
						collection: { id: "7", name: "example/widgets" },
						record: {
							id: "4200",
							sequence: "42",
							title: "Observe example events",
							url: "https://events.example.test/collections/widgets/records/42",
						},
						actor: { id: "9", name: "observer" },
						serviceName: "example-service",
					},
				})
				const staged = runtime.stage(first.events, first.eventSourceFingerprints)
				strictEqual(staged.inserted, 1)
				strictEqual(runtime.listReady().events.length, 0)
				deepStrictEqual(
					runtime.listStaged().events.map(({ event }) => event),
					first.events,
				)
				runtime.activate(projection({ revision: 2, enabled: false }))
				const projectionIneligibleRetry = structuredClone(exampleRecordObserved)
				firstLogRecord(projectionIneligibleRetry).attributes.push(
					...Array.from({ length: 257 }, (_, index) =>
						attr(`retry-projection-only-${index}`, { stringValue: "warehouse-valid" }),
					),
				)
				throws(
					() => runtime.evaluateOtlp("logs", projectionIneligibleRetry, () => true),
					/cannot safely recover staged source occurrence/,
				)
				strictEqual(runtime.listStaged().events.length, 1)
				strictEqual(runtime.listReady().events.length, 0)
				const changedRetry = structuredClone(exampleRecordObserved)
				firstLogRecord(changedRetry).body = { stringValue: "changed retry content" }
				throws(
					() => runtime.evaluateOtlp("logs", changedRetry, () => true),
					/staged source occurrence collision/,
				)
				strictEqual(runtime.listStaged().events.length, 1)
				strictEqual(runtime.listReady().events.length, 0)
				const retry = runtime.evaluateOtlp("logs", exampleRecordObserved, () => true)
				deepStrictEqual(retry.events, [])
				deepStrictEqual(retry.recoveredEventIds, staged.eventIds)
				runtime.markReady(retry.recoveredEventIds)
				deepStrictEqual(
					runtime.listReady().events.map(({ event }) => event),
					first.events,
				)
				deepStrictEqual(runtime.listStaged().events, [])
			} finally {
				store.close()
			}
		}))

	it("rejects same event bytes with conflicting source content within one batch", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store, undefined, exampleProjectors())
				runtime.activate(projection())
				const request = structuredClone(exampleRecordObserved)
				const first = firstLogRecord(request)
				first.attributes.push(attr("example.projector.ignored", { stringValue: "first" }))
				const second = structuredClone(first)
				second.attributes = second.attributes.map((entry) =>
					entry.key === "example.projector.ignored"
						? attr(entry.key, { stringValue: "second" })
						: entry,
				)
				request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(second)
				throws(
					() => runtime.evaluateOtlp("logs", request),
					/source occurrence collision within one ingest batch/,
				)
				strictEqual(runtime.listStaged().events.length, 0)
				strictEqual(runtime.listReady().events.length, 0)
			} finally {
				store.close()
			}
		}))

	it("activates a validated revision without restart and reloads it after restart", async () =>
		withDataDir(async (dataDir) => {
			let store = await LocalEventingControlStore.open(dataDir)
			let runtime = new LocalEventingRuntime(store, undefined, exampleProjectors())
			runtime.activate(projection())
			strictEqual(runtime.evaluateOtlp("logs", exampleRecordObserved).events.length, 1)
			runtime.activate(
				projection({
					revision: 2,
					selector: {
						op: "eq",
						field: { namespace: "signal", key: "event.name", type: "string" },
						value: { type: "string", value: "example.record.closed" },
					},
				}),
			)
			strictEqual(runtime.evaluateOtlp("logs", exampleRecordObserved).events.length, 0)
			store.close()

			store = await LocalEventingControlStore.open(dataDir)
			try {
				runtime = new LocalEventingRuntime(store, undefined, exampleProjectors())
				strictEqual(runtime.listActive()[0]?.revision, 2)
				strictEqual(runtime.evaluateOtlp("logs", exampleRecordObserved).events.length, 0)
			} finally {
				store.close()
			}
		}))

	it("does no normalization or event work for a source with no active projection", async () =>
		withDataDir(async (dataDir) => {
			const store = await LocalEventingControlStore.open(dataDir)
			try {
				const runtime = new LocalEventingRuntime(store)
				deepStrictEqual(runtime.evaluateOtlp("logs", { malformed: Symbol("not decoded") }), {
					events: [],
					eventSourceFingerprints: new Map(),
					recoveredEventIds: [],
					failures: [],
					typeMismatchFields: [],
				})
			} finally {
				store.close()
			}
		}))
})
