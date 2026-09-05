import { Effect } from "effect"
import { isReservedAgentName } from "@maple/domain/system-agents"
import type { TenantContext } from "@/services/auth/tenant-context"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { McpQueryError } from "@/mcp/tools/types"

/**
 * Agent-actor name derived from an MCP client's `initialize` clientInfo.name.
 * Normalized to the same shape `register_agent` accepts; reserved first-party
 * names are refused so a client cannot masquerade as Maple's own subsystems.
 */
const agentNameFromMcpClient = (clientName: string): string | null => {
	const normalized = clientName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "")
		.slice(0, 64)
	if (normalized.length === 0 || isReservedAgentName(normalized)) return null
	return normalized
}

const toResolveError = (error: { readonly message: string }) =>
	new McpQueryError({
		message: error.message,
		pipeName: "resolve_actor",
		cause: error,
	})

/**
 * Resolve the calling actor for issue-mutating MCP tools. Preference order:
 * the pre-resolved `tenant.actorId` (API-key/header-pinned agent identity),
 * then an agent actor derived from the MCP client's negotiated name, and only
 * then the authenticated user — so automation driven through a human session
 * shows up in the activity timeline as the agent that did it.
 */
export const resolveActor = Effect.fn("resolveActor")(function* (tenant: TenantContext) {
	if (tenant.actorId) return { actorId: tenant.actorId, isAgent: true }
	const actors = yield* ErrorActorsService

	const clientAgentName = tenant.mcpClientName ? agentNameFromMcpClient(tenant.mcpClientName) : null
	if (clientAgentName) {
		const agent = yield* actors
			.ensureAgentActor(tenant.orgId, clientAgentName, { createdBy: tenant.userId })
			.pipe(Effect.mapError(toResolveError))
		return { actorId: agent.id, isAgent: true }
	}

	const actor = yield* actors
		.ensureUserActor(tenant.orgId, tenant.userId)
		.pipe(Effect.mapError(toResolveError))
	return { actorId: actor.id, isAgent: false }
})

/** Convenience for tools that only need the id. */
export const resolveActorId = (tenant: TenantContext) =>
	Effect.map(resolveActor(tenant), (resolved) => resolved.actorId)
