import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, paramPlaceholder } from "@maple-dev/clickhouse-builder"
import { AuditLog } from "../tables"

/**
 * Which optional filters a listing applies. Every set flag binds a parameter of
 * the same name at compile time; the values themselves never enter the SQL.
 */
export interface AuditLogEntriesOpts {
	readonly actorType?: boolean
	readonly userId?: boolean
	readonly apiKeyId?: boolean
	readonly actorId?: boolean
	readonly affectedUserId?: boolean
	readonly action?: boolean
	readonly outcome?: boolean
	readonly resourceType?: boolean
	readonly resourceId?: boolean
	readonly changedField?: boolean
	readonly requestId?: boolean
	readonly since?: boolean
	readonly until?: boolean
	readonly limit: number
	readonly offset: number
}

/**
 * One org's audit log, newest first, offset-paginated. Pinned to the managed
 * route: the table is written through `ingest` and does not exist in a BYO
 * ClickHouse. A redelivered entry ReplacingMergeTree has not merged yet can
 * appear twice here; the service collapses it by id.
 */
export function auditLogEntriesQuery(opts: AuditLogEntriesOpts) {
	return from(AuditLog)
		.select(($) => ({
			id: $.Id,
			occurredAt: $.OccurredAt,
			recordedAt: $.RecordedAt,
			actorType: $.ActorType,
			userId: $.UserId,
			apiKeyId: $.ApiKeyId,
			actorId: $.ActorId,
			actorLabel: $.ActorLabel,
			affectedUserId: $.AffectedUserId,
			source: $.Source,
			action: $.Action,
			outcome: $.Outcome,
			denialReason: $.DenialReason,
			resourceType: $.ResourceType,
			resourceId: $.ResourceId,
			changedFields: $.ChangedFields,
			changes: $.Changes,
			metadata: $.Metadata,
			requestId: $.RequestId,
			originIp: $.OriginIp,
			originCountry: $.OriginCountry,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			opts.actorType ? $.ActorType.eq(param.string("actorType")) : undefined,
			opts.userId ? $.UserId.eq(param.string("userId")) : undefined,
			opts.apiKeyId ? $.ApiKeyId.eq(param.string("apiKeyId")) : undefined,
			opts.actorId ? $.ActorId.eq(param.string("actorId")) : undefined,
			opts.affectedUserId ? $.AffectedUserId.eq(param.string("affectedUserId")) : undefined,
			opts.action ? $.Action.eq(param.string("action")) : undefined,
			opts.outcome ? $.Outcome.eq(param.string("outcome")) : undefined,
			opts.resourceType ? $.ResourceType.eq(param.string("resourceType")) : undefined,
			opts.resourceId ? $.ResourceId.eq(param.string("resourceId")) : undefined,
			// Array membership has no builder verb yet; the placeholder keeps the
			// value parameterised exactly like the typed comparisons above.
			opts.changedField
				? CH.rawCond(`has(ChangedFields, ${paramPlaceholder("string", "changedField")})`)
				: undefined,
			opts.requestId ? $.RequestId.eq(param.string("requestId")) : undefined,
			opts.since ? $.OccurredAt.gte(param.dateTimeString("since")) : undefined,
			opts.until ? $.OccurredAt.lte(param.dateTimeString("until")) : undefined,
		])
		.orderBy(["occurredAt", "desc"], ["id", "desc"])
		.limit(opts.limit)
		.offset(opts.offset)
		.format("JSON")
		.route("ingest")
}

/** One listed entry as the warehouse returns it: `''` for absent values, JSON text for documents. */
export interface AuditLogEntriesOutput {
	readonly id: string
	readonly occurredAt: string
	readonly recordedAt: string
	readonly actorType: string
	readonly userId: string
	readonly apiKeyId: string
	readonly actorId: string
	readonly actorLabel: string
	readonly affectedUserId: string
	readonly source: string
	readonly action: string
	readonly outcome: string
	readonly denialReason: string
	readonly resourceType: string
	readonly resourceId: string
	readonly changedFields: ReadonlyArray<string>
	readonly changes: string
	readonly metadata: string
	readonly requestId: string
	readonly originIp: string
	readonly originCountry: string
}
