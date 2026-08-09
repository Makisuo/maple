import { makeResolveTenant, type TenantContext } from "@maple/auth"
import type { UnauthorizedError } from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { SyncConfig } from "../config"

export interface TenantResolverShape {
	readonly resolve: (
		headers: Record<string, string | undefined>,
	) => Effect.Effect<TenantContext, UnauthorizedError>
}

/**
 * Tenant resolution behind a service boundary.
 *
 * `makeResolveTenant` is pure config → function, so this wrapper adds no logic —
 * what it adds is a seam. Built inline in the route, it made every authenticated
 * path untestable: a test cannot mint a Clerk session, so nothing past the 401
 * could be reached, and the proxy's actual job (that *this* org's id is the one
 * pinned into the upstream WHERE) went unasserted. As a service it can be replaced
 * with a fixed tenant, which is what the router tests do.
 *
 * Clerk and self-hosted are both covered by `makeResolveTenant`; there is no
 * API-key path here, because this worker has no database and the browser's
 * shape-fetch only ever sends the session bearer.
 */
export class TenantResolver extends Context.Service<TenantResolver, TenantResolverShape>()(
	"@maple/electric-sync/TenantResolver",
	{
		make: Effect.gen(function* () {
			const config = yield* SyncConfig
			return { resolve: makeResolveTenant(config) } satisfies TenantResolverShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
