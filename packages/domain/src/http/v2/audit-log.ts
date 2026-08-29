import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AuditLogEntryId } from "../../primitives"
import {
	AuditActorType,
	AuditLogPersistenceError,
	AuditLogSource,
	AuditOutcome,
} from "../audit-log"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** `alog_…` public ID ⇄ internal `AuditLogEntryId` (raw UUID). */
export const AuditLogEntryPublicId = PublicId(PublicIdPrefixes.auditLogEntry, AuditLogEntryId)

const actorTypeField = AuditActorType.annotate({
	description:
		"Who performed the action: `user` (a dashboard session), `api_key` (a public-API credential), `agent` (a registered LLM agent acting over MCP), or `system` (Maple automation).",
	examples: ["user"],
})

const sourceField = AuditLogSource.annotate({
	description:
		"The surface the request arrived through: `dashboard`, `api` (the public v1/v2 API), `mcp`, or `system`.",
	examples: ["dashboard"],
})

const outcomeField = AuditOutcome.annotate({
	description:
		"Whether the action was performed (`allowed`) or refused (`denied`). Denied attempts — e.g. an API key lacking the required scope — are logged too.",
	examples: ["allowed"],
})

export const V2AuditChanges = Schema.Struct({
	fields: Schema.Array(Schema.String).annotate({
		description: "Names of the fields the update touched.",
		examples: [["name"]],
	}),
	before: Schema.Record(Schema.String, Schema.Unknown).annotate({
		description: "Prior values of the touched fields.",
	}),
	after: Schema.Record(Schema.String, Schema.Unknown).annotate({
		description: "New values of the touched fields.",
	}),
}).annotate({
	identifier: "AuditLogChanges",
	title: "Audit Log Changes",
	description: "The before/after diff an update applied, keyed by field name.",
})
export type V2AuditChanges = Schema.Schema.Type<typeof V2AuditChanges>

const auditLogEntryExample = {
	id: "alog_4CzLmR1pTxWvYbNhQd82Kf",
	object: "audit_log_entry",
	action: "alert_rule.updated",
	outcome: "allowed",
	denial_reason: null,
	actor_type: "user",
	actor_id: "user_2fj3K9dLqWm8xYbT",
	actor_name: "David",
	affected_user: null,
	source: "dashboard",
	resource_type: "alert_rule",
	resource_id: "alrt_YofPTrK9782DWwcnXhpcCw",
	changes: { fields: ["name"], before: { name: "Errors" }, after: { name: "High error rate" } },
	metadata: null,
	request_id: "8f2c1a9d4b7e3f60",
	origin_ip: "203.0.113.7",
	origin_country: "DE",
	occurred_at: "2026-08-29T09:12:00.000Z",
	recorded_at: "2026-08-29T09:12:00.412Z",
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AuditLogEntry = Schema.Struct({
	id: AuditLogEntryPublicId,
	object: Schema.Literal("audit_log_entry").annotate({
		description: 'The object type — always `"audit_log_entry"`.',
		examples: ["audit_log_entry"],
	}),
	action: Schema.String.annotate({
		description: "What happened, as `<resource>.<verb>` (e.g. `alert_rule.created`, `api_key.rolled`).",
		examples: ["alert_rule.created"],
	}),
	outcome: outcomeField,
	denial_reason: Schema.NullOr(Schema.String).annotate({
		description: "Why the action was refused, when `outcome` is `denied`; otherwise `null`.",
	}),
	actor_type: actorTypeField,
	actor_id: Schema.NullOr(Schema.String).annotate({
		description:
			"Public identifier of the actor: a `user_…` ID for users, a `key_…` ID for API keys, an `actor_…` ID for agents, or `null` for system actions.",
		examples: ["user_2fj3K9dLqWm8xYbT"],
	}),
	actor_name: Schema.NullOr(Schema.String).annotate({
		description:
			"Display name of the actor at the time of the action (agent name, API key name, …), or `null` when none was recorded.",
		examples: ["David"],
	}),
	affected_user: Schema.NullOr(Schema.String).annotate({
		description:
			"The `user_…` ID of the user the action was performed on (e.g. a removed member), when different from the actor; otherwise `null`.",
	}),
	source: sourceField,
	resource_type: Schema.NullOr(Schema.String).annotate({
		description: "The kind of resource acted on (e.g. `alert_rule`, `dashboard`), or `null`.",
		examples: ["alert_rule"],
	}),
	resource_id: Schema.NullOr(Schema.String).annotate({
		description: "Public ID of the resource acted on, or `null`.",
		examples: ["alrt_YofPTrK9782DWwcnXhpcCw"],
	}),
	changes: Schema.NullOr(V2AuditChanges).annotate({
		description: "The before/after diff for updates, or `null` when the action carries no diff.",
	}),
	metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)).annotate({
		description: "Action-specific context recorded with the entry, or `null`.",
	}),
	request_id: Schema.NullOr(Schema.String).annotate({
		description:
			"Identifier of the HTTP request that performed the action, shared by every entry the request produced; or `null`.",
	}),
	origin_ip: Schema.NullOr(Schema.String).annotate({
		description: "Client IP the request originated from, or `null`.",
	}),
	origin_country: Schema.NullOr(Schema.String).annotate({
		description: "ISO 3166-1 country code the request originated from, or `null`.",
	}),
	occurred_at: Timestamp.annotate({ description: "When the action happened." }),
	recorded_at: Timestamp.annotate({
		description:
			"When the entry was durably recorded. Trails `occurred_at` by the audit pipeline's delivery latency.",
	}),
}).annotate({
	identifier: "AuditLogEntry",
	title: "Audit Log Entry",
	description:
		"One entry in the organization's append-only audit log: an allowed or denied action performed by a user, API key, or agent against a Maple resource.",
	examples: [wireExample(auditLogEntryExample)],
})
export type V2AuditLogEntry = Schema.Schema.Type<typeof V2AuditLogEntry>

/** Audit-log list query: standard pagination plus actor/action/resource/outcome/time filters. */
export const V2AuditLogQuery = Schema.Struct({
	...ListQuery.fields,
	actor_type: Schema.optional(
		AuditActorType.annotate({
			description: "Only return entries performed by this kind of actor.",
		}),
	),
	actor_id: Schema.optional(
		Schema.String.annotate({
			description:
				"Only return entries performed by this specific actor: a `user_…` user ID, `key_…` API key ID, or `actor_…` agent ID.",
		}),
	),
	affected_user: Schema.optional(
		Schema.String.annotate({
			description: "Only return entries that acted on this `user_…` user.",
		}),
	),
	action: Schema.optional(
		Schema.String.annotate({
			description: "Only return entries with exactly this action (e.g. `alert_rule.created`).",
		}),
	),
	outcome: Schema.optional(
		AuditOutcome.annotate({
			description: "Only return entries with this outcome.",
		}),
	),
	resource_type: Schema.optional(
		Schema.String.annotate({
			description: "Only return entries acting on this kind of resource (e.g. `dashboard`).",
		}),
	),
	resource_id: Schema.optional(
		Schema.String.annotate({
			description:
				"Only return entries acting on this exact resource, by its public ID (e.g. `dash_…`).",
		}),
	),
	changed: Schema.optional(
		Schema.String.annotate({
			description: "Only return entries whose update touched this field name (e.g. `scopes`).",
		}),
	),
	request_id: Schema.optional(
		Schema.String.annotate({
			description: "Only return entries produced by this HTTP request.",
		}),
	),
	since: Schema.optional(
		Timestamp.annotate({
			description: "Only return entries that occurred at or after this time.",
		}),
	),
	until: Schema.optional(
		Timestamp.annotate({
			description: "Only return entries that occurred at or before this time.",
		}),
	),
}).annotate({
	identifier: "AuditLogQuery",
	title: "Audit log query",
	description:
		"Pagination plus optional actor, action, outcome, resource, changed-field, request, and time-window filters.",
})
export type V2AuditLogQuery = Schema.Schema.Type<typeof V2AuditLogQuery>

const [auditLogPersistence] = publicErrors(AuditLogPersistenceError)

const AuditLogEntryList = ListOf(V2AuditLogEntry).annotate({
	identifier: "AuditLogEntryList",
	title: "Audit log entry list",
	description: "A cursor-paginated page of audit log entries, newest first.",
})

export class V2AuditLogApiGroup extends HttpApiGroup.make("auditLog")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2AuditLogQuery,
			success: AuditLogEntryList,
			error: [V2ParameterInvalid.schema, V2InsufficientPermissions.schema, auditLogPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAuditLogEntries",
				summary: "List audit log entries",
				description:
					"Returns your organization's audit log, newest first, optionally filtered by actor, action, outcome, resource, changed field, request, and time window. Cursor-paginated. Session callers must be organization administrators; API keys require the `audit_log:read` scope.",
			}),
		),
	)
	.prefix("/v2/audit_log")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Audit Log",
			description:
				"The organization's append-only audit trail — allowed and denied actions performed through the dashboard, the public API, and MCP, attributed to the user, API key, or agent that performed them, with before/after diffs for updates. Reading it requires organization-administrator access (or the `audit_log:read` scope for API keys).",
		}),
	) {}
