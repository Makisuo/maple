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
	/**
	 * Name the MCP client declared in its `initialize` handshake
	 * (`clientInfo.name`, e.g. "claude-code"). When no explicit `actorId` is
	 * pinned, issue-mutating MCP tools attribute writes to an agent actor
	 * derived from this name instead of the authenticated user, so automation
	 * driven through a human's session still reads as the agent in the
	 * activity timeline.
	 */
	mcpClientName?: string
}
