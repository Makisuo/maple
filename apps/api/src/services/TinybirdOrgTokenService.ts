import { Clock, Context, Effect, Layer, Redacted } from "effect"
import { listOrgScopedDatasourceNames } from "../mcp/lib/warehouse-catalog"
import { deriveWorkspaceId, mintOrgReadJwt } from "../lib/tinybird-jwt"
import { Env } from "../lib/Env"

// ---------------------------------------------------------------------------
// TinybirdOrgTokenService — mints and caches per-org Tinybird read JWTs used to
// scope the raw-SQL path to a single org's rows (row-level security enforced by
// Tinybird server-side; see lib/tinybird-jwt.ts).
//
// A JWT is reused for its lifetime and re-minted on expiry. The cache entry
// expires SKEW seconds before the token itself, so a served token always has
// comfortably more life left than the executor's 30s client-cache TTL — a cached
// Tinybird client never outlives the JWT it was built with.
// ---------------------------------------------------------------------------

/** Token lifetime. */
const JWT_TTL_SECONDS = 600
/** Re-mint this many seconds before true expiry (must exceed the executor's 30s client cache). */
const JWT_REFRESH_SKEW_SECONDS = 60

export interface TinybirdOrgTokenServiceShape {
	/** A Tinybird read JWT scoped to `orgId` across every OrgId-bearing datasource. */
	readonly getOrgReadToken: (orgId: string) => Effect.Effect<string>
}

export class TinybirdOrgTokenService extends Context.Service<
	TinybirdOrgTokenService,
	TinybirdOrgTokenServiceShape
>()("@maple/api/services/TinybirdOrgTokenService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const adminToken = Redacted.value(env.TINYBIRD_TOKEN)
		// The scope allowlist is static per deploy — compute it once.
		const datasourceNames = listOrgScopedDatasourceNames()

		// Derive the workspace id lazily (on first mint), so constructing the layer
		// never fails on a non-Tinybird token — tests and non-raw-SQL paths that
		// never mint a scoped JWT don't need a real admin token.
		let workspaceId: string | null = null
		const getWorkspaceId = () => (workspaceId ??= deriveWorkspaceId(adminToken))

		// Per-instance (per-isolate) cache. `expiresAt` is the re-mint deadline in ms.
		const cache = new Map<string, { token: string; expiresAt: number }>()

		const getOrgReadToken = Effect.fn("TinybirdOrgTokenService.getOrgReadToken")(function* (
			orgId: string,
		) {
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && cached.expiresAt > nowMs) {
				yield* Effect.annotateCurrentSpan("tinybird.jwt.cacheHit", true)
				return cached.token
			}
			yield* Effect.annotateCurrentSpan("tinybird.jwt.cacheHit", false)
			const token = mintOrgReadJwt({
				adminToken,
				workspaceId: getWorkspaceId(),
				orgId,
				datasourceNames,
				nowSeconds: Math.floor(nowMs / 1000),
				ttlSeconds: JWT_TTL_SECONDS,
			})
			cache.set(orgId, {
				token,
				expiresAt: nowMs + (JWT_TTL_SECONDS - JWT_REFRESH_SKEW_SECONDS) * 1000,
			})
			return token
		})

		return { getOrgReadToken } satisfies TinybirdOrgTokenServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
