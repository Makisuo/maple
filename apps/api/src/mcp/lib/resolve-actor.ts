import { Effect } from "effect"
import type { ActorId } from "@maple/domain/http"
import type { TenantContext } from "@/lib/tenant-context"
import { ErrorsService } from "@/services/ErrorsService"
import { McpQueryError } from "../tools/types"

/**
 * Resolve the calling actor for issue-mutating MCP tools. Prefers the
 * pre-resolved `tenant.actorId` (API-key-backed agent identity) and falls
 * back to a lazily-created user actor row.
 */
export const resolveActorId = (tenant: TenantContext): Effect.Effect<ActorId, McpQueryError, ErrorsService> =>
	Effect.gen(function* () {
		if (tenant.actorId) return tenant.actorId
		const errors = yield* ErrorsService
		const actor = yield* errors.ensureUserActor(tenant.orgId, tenant.userId).pipe(
			Effect.mapError(
				(error) =>
					new McpQueryError({
						message: error.message,
						pipe: "resolve_actor",
						cause: error,
					}),
			),
		)
		return actor.id
	})
