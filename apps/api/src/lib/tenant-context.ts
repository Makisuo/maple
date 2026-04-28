import type { ActorId, AuthMode, OrgId, RoleName, UserId } from "@maple/domain/http"

export interface TenantContext {
	orgId: OrgId
	userId: UserId
	roles: RoleName[]
	authMode: AuthMode
	/**
	 * Pre-resolved actor for API-key-backed agent identities. When set,
	 * issue-mutating tools should prefer this over `ensureUserActor(userId)`
	 * so that an agent's actions are attributed to the agent row rather than
	 * a synthetic user row.
	 */
	actorId?: ActorId
}
