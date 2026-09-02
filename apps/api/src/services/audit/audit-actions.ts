import { encodePublicId, type PublicIdPrefix, PublicIdPrefixes } from "@maple/domain/http/v2"
import { ErrorIssueEventType } from "@maple/domain/http"

/**
 * Every audited action in Maple, grouped by the resource it acts on.
 *
 * The key is both the `resource_type` stored on the row and the `<resource>`
 * half of the `<resource>.<verb>` action string, so the two can never disagree.
 * `prefix` is the public-ID prefix the resource's internal ID is encoded with;
 * resources that are org-singletons (`ingest_key`, `anomaly_settings`) or carry
 * no resource at all (`api`) omit it, and passing a `resourceId` for one of
 * those is a type error.
 *
 * Adding an entry here is what makes `record({ action: "<resource>.<verb>" })`
 * compile — a typo, or an action recorded before it is declared, fails the build.
 */
export const AuditResources = {
	agent: { prefix: PublicIdPrefixes.actor, verbs: ["registered"] },
	alert_destination: {
		prefix: PublicIdPrefixes.alertDestination,
		verbs: ["created", "updated", "deleted"],
	},
	alert_rule: { prefix: PublicIdPrefixes.alertRule, verbs: ["created", "updated", "deleted"] },
	anomaly_incident: { prefix: PublicIdPrefixes.anomalyIncident, verbs: ["resolved"] },
	/** Org-singleton settings — no resource id. */
	anomaly_settings: { verbs: ["updated"] },
	/** Refused requests, recorded by the auth layers; the route is in `metadata`. */
	api: { verbs: ["request"] },
	api_key: { prefix: PublicIdPrefixes.apiKey, verbs: ["created", "rolled", "revoked"] },
	attribute_mapping: {
		prefix: PublicIdPrefixes.attributeMapping,
		verbs: ["created", "updated", "deleted"],
	},
	dashboard: {
		prefix: PublicIdPrefixes.dashboard,
		verbs: ["created", "updated", "deleted", "version_restored"],
	},
	dashboard_share: { prefix: PublicIdPrefixes.dashboardShare, verbs: ["created", "rotated", "deleted"] },
	/** Verbs mirror the issue event types — `recordEvent` audits every one it attributes. */
	error_issue: { prefix: PublicIdPrefixes.errorIssue, verbs: ErrorIssueEventType.literals },
	/** Org-singleton public/private pair; which one rolled is in `metadata`. */
	ingest_key: { verbs: ["rolled"] },
	/**
	 * Every MCP tool invocation, whichever surface drove it (MCP transport, the
	 * in-app chat, workflows, internal RPC). The tool and its parameters are in
	 * `metadata`; a tool that also mutates a resource records that action too.
	 */
	mcp_tool: { verbs: ["called"] },
	investigation: { prefix: PublicIdPrefixes.investigation, verbs: ["created", "restarted", "status_changed"] },
	/**
	 * Org-singleton connections. `*_started` is the admin action Maple sees; the
	 * OAuth round trip completes at the provider's callback.
	 */
	planetscale_integration: {
		verbs: ["connect_started", "organization_selected", "metrics_token_set", "disconnected"],
	},
	slack_integration: { verbs: ["install_started", "uninstalled"] },
	/**
	 * Org membership, learned from Clerk's webhook — the web app changes members
	 * in Clerk directly, so nothing reaches Maple's own API. The member is the
	 * entry's `affected_user`; no prefix, since Clerk IDs are already public.
	 */
	member: { verbs: ["added", "role_changed", "removed"] },
	/**
	 * The org itself. No prefix: every row already carries `org_id`, and a
	 * deleted org has no public ID left to resolve.
	 */
	organization: { verbs: ["deleted"] },
	scrape_target: { prefix: PublicIdPrefixes.scrapeTarget, verbs: ["created", "updated", "deleted"] },
	/**
	 * Reads of recorded browser sessions — the surface most likely to carry
	 * end-user data. Recorded by the auth layers from the `AuditedRead` annotation.
	 */
	session_replay: { verbs: ["read"] },
	/**
	 * Reads of traces, logs, metrics and error events (`read`, from the
	 * `AuditedRead` annotation on the endpoint) and every raw SQL statement run
	 * against the warehouse (`sql_executed`, with the statement in `metadata`).
	 */
	telemetry: { verbs: ["read", "sql_executed"] },
	/** Org-singleton BYO-ClickHouse connection; holds warehouse credentials. */
	warehouse_settings: { verbs: ["updated", "deleted", "schema_applied"] },
	/** Short-lived device credentials for the mobile widget; keyed by installation. */
	widget_credential: { verbs: ["minted", "revoked"] },
} as const satisfies Record<string, AuditResourceDefinition>

interface AuditResourceDefinition {
	readonly prefix?: PublicIdPrefix
	readonly verbs: ReadonlyArray<string>
}

export type AuditResourceType = keyof typeof AuditResources

/** `<resource>.<verb>` for every declared pair — the closed set of audit actions. */
export type AuditAction = {
	[K in AuditResourceType]: `${K}.${(typeof AuditResources)[K]["verbs"][number]}`
}[AuditResourceType]

type ResourceOf<A extends AuditAction> = A extends `${infer R}.${string}`
	? R extends AuditResourceType
		? R
		: never
	: never

/**
 * The `resourceId` option for an action: the resource's *internal* ID, encoded
 * to its public `<prefix>_…` form on the way to the row. Resources that declare
 * no prefix (org-singletons) accept no `resourceId` at all.
 */
export type AuditResourceIdOption<A extends AuditAction> = (typeof AuditResources)[ResourceOf<A>] extends {
	readonly prefix: PublicIdPrefix
}
	? { readonly resourceId?: string }
	: { readonly resourceId?: never }

/**
 * Derive the row's `resource_type` from the action and encode the internal
 * resource ID into its public form, so no call site restates either.
 */
export const auditResourceFields = (
	action: AuditAction,
	resourceId?: string,
): { readonly resourceType: AuditResourceType; readonly resourceId?: string } => {
	// SAFETY: every `AuditAction` is built as `${resource}.${verb}` from the keys
	// of `AuditResources`, so the segment before the dot is always one of them.
	const resourceType = action.slice(0, action.indexOf(".")) as AuditResourceType
	const resource = AuditResources[resourceType]
	// Narrow rather than widen: org-singleton resources declare no `prefix` at all.
	const prefix = "prefix" in resource ? resource.prefix : undefined
	return {
		resourceType,
		...(resourceId !== undefined && prefix !== undefined
			? { resourceId: encodePublicId(prefix, resourceId) }
			: undefined),
	}
}
