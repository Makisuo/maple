import {
	AuditActorType,
	AuditChanges,
	AuditLogSource,
	AuditOutcome,
} from "@maple/domain/http"
import { ActorId, ApiKeyId, AuditLogEntryId, OrgId, UserId } from "@maple/domain/primitives"
import type { AuditLogRow } from "@maple/domain/tinybird"
import { Schema, SchemaTransformation } from "effect"
import { msToDate, msToWarehouseDateTime64 } from "@/platform/time"

/**
 * The serialized audit event as it travels the audit queue. `occurredAtMs` is
 * stamped by the producer; `recordedAt` exists only on the stored row, stamped
 * by whichever writer performs the insert.
 */
export class AuditLogEvent extends Schema.Class<AuditLogEvent>("AuditLogEvent")({
	orgId: OrgId,
	id: AuditLogEntryId,
	actorType: AuditActorType,
	userId: Schema.optionalKey(UserId),
	apiKeyId: Schema.optionalKey(ApiKeyId),
	actorId: Schema.optionalKey(ActorId),
	actorLabel: Schema.optionalKey(Schema.String),
	affectedUserId: Schema.optionalKey(UserId),
	source: AuditLogSource,
	action: Schema.String,
	outcome: AuditOutcome,
	denialReason: Schema.optionalKey(Schema.String),
	resourceType: Schema.optionalKey(Schema.String),
	resourceId: Schema.optionalKey(Schema.String),
	changes: Schema.optionalKey(AuditChanges),
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	requestId: Schema.optionalKey(Schema.String),
	originIp: Schema.optionalKey(Schema.String),
	originCountry: Schema.optionalKey(Schema.String),
	occurredAtMs: Schema.Finite,
}) {}

export const decodeAuditLogEvent = Schema.decodeUnknownEffect(AuditLogEvent)
export const encodeAuditLogEventSync = Schema.encodeSync(AuditLogEvent)

/**
 * One stored audit entry, as the service hands it to readers. Absent values are
 * `null` here and `''` in the warehouse row; the two lowering functions below
 * are the only places that mapping lives.
 */
export interface AuditLogEntry {
	readonly orgId: OrgId
	readonly id: AuditLogEntryId
	readonly actorType: AuditActorType
	readonly userId: UserId | null
	readonly apiKeyId: ApiKeyId | null
	readonly actorId: ActorId | null
	readonly actorLabel: string | null
	readonly affectedUserId: UserId | null
	readonly source: AuditLogSource
	readonly action: string
	readonly outcome: AuditOutcome
	readonly denialReason: string | null
	readonly resourceType: string | null
	readonly resourceId: string | null
	readonly changedFields: ReadonlyArray<string> | null
	readonly changes: AuditChanges | null
	readonly metadata: Record<string, unknown> | null
	readonly requestId: string | null
	readonly originIp: string | null
	readonly originCountry: string | null
	readonly occurredAt: Date
	readonly recordedAt: Date
}

/** Lower a queue event to its `audit_log` warehouse row; `recordedAtMs` is the write time. */
export const auditEventToRow = (event: AuditLogEvent, recordedAtMs: number): AuditLogRow => ({
	OrgId: event.orgId,
	Id: event.id,
	OccurredAt: msToWarehouseDateTime64(event.occurredAtMs),
	RecordedAt: msToWarehouseDateTime64(recordedAtMs),
	ActorType: event.actorType,
	UserId: event.userId ?? "",
	ApiKeyId: event.apiKeyId ?? "",
	ActorId: event.actorId ?? "",
	ActorLabel: event.actorLabel ?? "",
	AffectedUserId: event.affectedUserId ?? "",
	Source: event.source,
	Action: event.action,
	Outcome: event.outcome,
	DenialReason: event.denialReason ?? "",
	ResourceType: event.resourceType ?? "",
	ResourceId: event.resourceId ?? "",
	ChangedFields: event.changes === undefined ? [] : [...event.changes.fields],
	Changes: event.changes === undefined ? "" : JSON.stringify(event.changes),
	Metadata: event.metadata === undefined ? "" : JSON.stringify(event.metadata),
	RequestId: event.requestId ?? "",
	OriginIp: event.originIp ?? "",
	OriginCountry: event.originCountry ?? "",
})

/** The entry a reader would get back for `event` — what the in-memory layer stores. */
export const auditEventToEntry = (event: AuditLogEvent, recordedAtMs: number): AuditLogEntry => ({
	orgId: event.orgId,
	id: event.id,
	actorType: event.actorType,
	userId: event.userId ?? null,
	apiKeyId: event.apiKeyId ?? null,
	actorId: event.actorId ?? null,
	actorLabel: event.actorLabel ?? null,
	affectedUserId: event.affectedUserId ?? null,
	source: event.source,
	action: event.action,
	outcome: event.outcome,
	denialReason: event.denialReason ?? null,
	resourceType: event.resourceType ?? null,
	resourceId: event.resourceId ?? null,
	changedFields: event.changes === undefined ? null : [...event.changes.fields],
	changes: event.changes ?? null,
	metadata: event.metadata ?? null,
	requestId: event.requestId ?? null,
	originIp: event.originIp ?? null,
	originCountry: event.originCountry ?? null,
	occurredAt: msToDate(event.occurredAtMs),
	recordedAt: msToDate(recordedAtMs),
})

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/** `''` in the warehouse row is "absent"; everything else decodes through `schema`. */
const emptyAsNull = <S extends Schema.Codec<any, string, any, any>>(schema: S) =>
	Schema.String.pipe(
		Schema.decodeTo(
			Schema.NullOr(Schema.String),
			SchemaTransformation.transform({
				decode: (value: string) => (value === "" ? null : value),
				encode: (value: string | null) => value ?? "",
			}),
		),
		Schema.decodeTo(Schema.NullOr(schema)),
	)

const nullableText = emptyAsNull(Schema.String)

/** JSON document columns: `''` when absent, otherwise a JSON string of `schema`. */
const jsonDocument = <S extends Schema.Top>(schema: S) => emptyAsNull(Schema.fromJsonString(schema))

/**
 * `YYYY-MM-DD HH:mm:ss.SSS` (UTC, as the warehouse emits DateTime64) ⇄ `Date`;
 * an ISO rendering with `T`/`Z` is accepted as-is should a backend emit one.
 */
const warehouseDateTime = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Date,
		SchemaTransformation.transform({
			decode: (value: string) => new Date(/[TZ]/.test(value) ? value : `${value.replace(" ", "T")}Z`),
			encode: (value: Date) => msToWarehouseDateTime64(value.getTime()),
		}),
	),
)

/**
 * A listed row exactly as the warehouse returns it, with the `''`-means-absent
 * convention decoded back to `null` and the JSON document columns parsed.
 */
export const StoredAuditLogEntry = Schema.Struct({
	id: AuditLogEntryId,
	occurredAt: warehouseDateTime,
	recordedAt: warehouseDateTime,
	actorType: AuditActorType,
	userId: emptyAsNull(UserId),
	apiKeyId: emptyAsNull(ApiKeyId),
	actorId: emptyAsNull(ActorId),
	actorLabel: nullableText,
	affectedUserId: emptyAsNull(UserId),
	source: AuditLogSource,
	action: Schema.String,
	outcome: AuditOutcome,
	denialReason: nullableText,
	resourceType: nullableText,
	resourceId: nullableText,
	changedFields: Schema.Array(Schema.String),
	changes: jsonDocument(AuditChanges),
	metadata: jsonDocument(JsonRecord),
	requestId: nullableText,
	originIp: nullableText,
	originCountry: nullableText,
})

export const decodeStoredAuditLogEntry = Schema.decodeUnknownEffect(StoredAuditLogEntry)

/** A decoded warehouse row as an `AuditLogEntry`. */
export const storedRowToEntry = (
	orgId: OrgId,
	row: Schema.Schema.Type<typeof StoredAuditLogEntry>,
): AuditLogEntry => ({
	orgId,
	...row,
	// An entry with no diff has no changed fields either; the row stores `[]`.
	changedFields: row.changes === null ? null : row.changedFields,
})
