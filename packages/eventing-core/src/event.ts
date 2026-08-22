import { createHash } from "node:crypto"
import { Schema } from "effect"
import {
	MapleCloudEventSchema,
	type JsonValue,
	type MapleCloudEvent,
	type NormalizedSignal,
	type SignalProjectionSpec,
} from "./model"
import { timestampToEpochNanos } from "./predicate"

export const MAX_CLOUD_EVENT_BYTES = 256 * 1024

export interface EventIdentityInput {
	readonly tenantId: string
	readonly sourceKind: string
	readonly source: string
	readonly occurrenceId: string
	readonly projectionId: string
	readonly projectionRevision: number
}

const updateLengthDelimited = (hash: ReturnType<typeof createHash>, value: string): void => {
	const encoded = Buffer.from(value, "utf8")
	const length = Buffer.allocUnsafe(4)
	length.writeUInt32BE(encoded.byteLength)
	hash.update(length)
	hash.update(encoded)
}

/** Canonical v1 identity shared by every host implementation. */
export const makeEventId = (input: EventIdentityInput): string => {
	const hash = createHash("sha256")
	for (const field of [
		"maple-event-v1",
		input.tenantId,
		input.sourceKind,
		input.source,
		input.occurrenceId,
		input.projectionId,
		String(input.projectionRevision),
	])
		updateLengthDelimited(hash, field)
	return `sha256:${hash.digest("hex")}`
}

export const isJsonValue = (value: unknown, seen: Set<object> = new Set()): value is JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true
	if (typeof value === "number") return Number.isFinite(value)
	if (typeof value !== "object") return false
	if (seen.has(value)) return false
	seen.add(value)
	try {
		if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen))
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return false
		return Object.values(value).every((item) => isJsonValue(item, seen))
	} finally {
		// Track the active recursion path. Repeated references serialize as a
		// JSON tree and are not themselves cycles.
		seen.delete(value)
	}
}

const canonicalizeJson = (value: JsonValue): JsonValue => {
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(canonicalizeJson)
	const record = value as { readonly [key: string]: JsonValue }
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, canonicalizeJson(record[key]!)]),
	)
}

/** Stable JSON encoding for outbox collision checks and cross-host fixtures. */
export const canonicalJson = (value: JsonValue): string => {
	if (!isJsonValue(value)) throw new Error("value must be finite acyclic JSON")
	return JSON.stringify(canonicalizeJson(value))
}

export interface ValidatedMapleCloudEvent {
	readonly event: MapleCloudEvent
	readonly canonicalJson: string
	readonly byteLength: number
}

/** Validate the complete persisted envelope, including its canonical byte budget. */
export const validateMapleCloudEvent = (candidate: unknown): ValidatedMapleCloudEvent => {
	const event = Schema.decodeUnknownSync(MapleCloudEventSchema)(candidate)
	if (!isJsonValue(event)) throw new Error("CloudEvent must be finite JSON")
	// SAFETY: the envelope schema and finite-JSON guard establish MapleCloudEvent's complete contract.
	const validatedEvent = event as MapleCloudEvent
	const eventJson = canonicalJson(event)
	const byteLength = Buffer.byteLength(eventJson, "utf8")
	if (byteLength > MAX_CLOUD_EVENT_BYTES)
		throw new Error(`CloudEvent exceeds ${MAX_CLOUD_EVENT_BYTES} UTF-8 bytes`)
	return { event: validatedEvent, canonicalJson: eventJson, byteLength }
}

export const makeCloudEvent = (input: {
	readonly signal: NormalizedSignal
	readonly projection: SignalProjectionSpec
	readonly projectorId: string
	readonly projectorVersion: number
	readonly outputType: string
	readonly dataSchema: string
	readonly subject?: string | null
	readonly time?: string
	readonly data: JsonValue
}): MapleCloudEvent => {
	if (
		input.signal.occurrenceId === null ||
		input.signal.occurrenceId.trim().length === 0 ||
		input.signal.identityQuality === "none"
	)
		throw new Error("durable event projection requires stable or derived occurrence identity")
	if (!isJsonValue(input.data)) throw new Error("projected event data must be finite JSON")
	if (input.outputType.trim().length === 0) throw new Error("projected event type must not be empty")
	if (input.dataSchema.trim().length === 0) throw new Error("projected event data schema must not be empty")
	if (input.signal.source.trim().length === 0) throw new Error("signal source must not be empty")

	const subject = input.subject ?? input.signal.subject
	const time = input.time ?? input.signal.occurredAt
	if (timestampToEpochNanos(time) === null) throw new Error("projected event time must be a valid instant")
	const envelope = {
		specversion: "1.0",
		id: makeEventId({
			tenantId: input.signal.tenantId,
			sourceKind: input.signal.sourceKind,
			source: input.signal.source,
			occurrenceId: input.signal.occurrenceId,
			projectionId: input.projection.id,
			projectionRevision: input.projection.revision,
		}),
		source: input.signal.source,
		type: input.outputType,
		time,
		datacontenttype: "application/json",
		dataschema: input.dataSchema,
		tenantid: input.signal.tenantId,
		projectionid: input.projection.id,
		projectionrevision: input.projection.revision,
		projectorid: input.projectorId,
		projectorversion: input.projectorVersion,
		sourceoccurrenceid: input.signal.occurrenceId,
		sourceidentityquality: input.signal.identityQuality,
		data: input.data,
	}
	return validateMapleCloudEvent(subject == null ? envelope : { ...envelope, subject }).event
}
