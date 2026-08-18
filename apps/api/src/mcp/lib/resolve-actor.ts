import { Effect } from "effect"
import type { TenantContext } from "@/services/auth/tenant-context"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { McpQueryError } from "@/mcp/tools/types"

/**
 * Resolve the calling actor for issue-mutating MCP tools. Prefers the
 * pre-resolved `tenant.actorId` (API-key-backed agent identity) and falls
 * back to a lazily-created user actor row.
 */
export const resolveActorId = Effect.fn("resolveActorId")(function* (tenant: TenantContext) {
	if (tenant.actorId) return tenant.actorId
	const actors = yield* ErrorActorsService
	const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId).pipe(
		Effect.mapError(
			(error) =>
				new McpQueryError({
					message: error.message,
					pipeName: "resolve_actor",
					cause: error,
				}),
		),
	)
	return actor.id
})
