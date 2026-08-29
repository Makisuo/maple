import { AuditActorType, AuditChanges, AuditLogSource, AuditOutcome } from "@maple/domain/http"
import { ActorId, ApiKeyId, AuditLogEntryId, OrgId, UserId } from "@maple/domain/primitives"
import type { AuditLogEntryInsert } from "@maple/db"
import { Schema } from "effect"
import { msToDate } from "@/platform/time"

/**
 * The serialized audit event as it travels the audit queue. `occurredAtMs` is
 * stamped by the producer; `recordedAt` exists only on the table row, stamped
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
	occurredAtMs: Schema.Number,
}) {}

export const decodeAuditLogEvent = Schema.decodeUnknownEffect(AuditLogEvent)
export const encodeAuditLogEventSync = Schema.encodeSync(AuditLogEvent)

/** Lower a queue event to its table row; `recordedAtMs` is the insert time. */
export const auditEventToInsert = (event: AuditLogEvent, recordedAtMs: number): AuditLogEntryInsert => ({
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
	changesJson: event.changes ?? null,
	metadataJson: event.metadata ?? null,
	requestId: event.requestId ?? null,
	originIp: event.originIp ?? null,
	originCountry: event.originCountry ?? null,
	occurredAt: msToDate(event.occurredAtMs),
	recordedAt: msToDate(recordedAtMs),
})
