import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

/**
 * Who performed an audited action. `user` is a dashboard session, `api_key` a
 * v1/v2 public-API credential, `agent` a registered LLM agent acting over MCP,
 * and `system` Maple itself (crons, sweeps, lifecycle automation).
 */
export const AuditActorType = Schema.Literals(["user", "api_key", "agent", "system"]).annotate({
	identifier: "@maple/AuditActorType",
	title: "Audit Actor Type",
})
export type AuditActorType = Schema.Schema.Type<typeof AuditActorType>

/** Which surface the audited request arrived through. */
export const AuditLogSource = Schema.Literals(["dashboard", "api", "mcp", "system"]).annotate({
	identifier: "@maple/AuditLogSource",
	title: "Audit Log Source",
})
export type AuditLogSource = Schema.Schema.Type<typeof AuditLogSource>

/** Whether the action was performed or refused — denied attempts are logged too. */
export const AuditOutcome = Schema.Literals(["allowed", "denied"]).annotate({
	identifier: "@maple/AuditOutcome",
	title: "Audit Outcome",
})
export type AuditOutcome = Schema.Schema.Type<typeof AuditOutcome>

/** Before/after diff of an update, with the touched field names queryable on their own. */
export const AuditChanges = Schema.Struct({
	fields: Schema.Array(Schema.String),
	before: Schema.Record(Schema.String, Schema.Unknown),
	after: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({
	identifier: "@maple/AuditChanges",
	title: "Audit Changes",
})
export type AuditChanges = Schema.Schema.Type<typeof AuditChanges>

export class AuditLogPersistenceError extends HttpTaggedError<AuditLogPersistenceError>()(
	"@maple/http/errors/AuditLogPersistenceError",
	{
		message: Schema.String,
		// Diagnostic only — `exposure: "redacted"` keeps it off the wire.
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "audit_log_unavailable",
		title: "The audit log is temporarily unavailable",
		message: "The audit log is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
