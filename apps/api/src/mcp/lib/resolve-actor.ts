import { Effect } from "effect"
import type { TenantContext } from "@/lib/tenant-context"
import { ErrorsService } from "@/services/ErrorsService"
import { McpQueryError } from "@/mcp/tools/types"

/**
 * Resolve the calling actor for issue-mutating MCP tools. Prefers the
 * pre-resolved `tenant.actorId` (API-key-backed agent identity) and falls
 * back to a lazily-created user actor row.
 */
export const resolveActorId = Effect.fn("resolveActorId")(function* (tenant: TenantContext) {
	if (tenant.actorId) return tenant.actorId
	const errors = yield* ErrorsService
	const actor = yield* errors.ensureUserActor(tenant.orgId, tenant.userId).pipe(
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
