import type { OrgId } from "@maple/domain"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { listOrgScopedDatasourceNames } from "../lib/warehouse-catalog"
import { mintOrgReadJwt } from "../lib/tinybird-jwt"
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
	readonly getOrgReadToken: (orgId: OrgId) => Effect.Effect<string, TinybirdOrgTokenError>
}

export class TinybirdOrgTokenError extends Schema.TaggedErrorClass<TinybirdOrgTokenError>()(
	"@maple/api/services/TinybirdOrgTokenError",
	{
		reason: Schema.Literals(["MissingSigningKey", "MissingWorkspaceId", "MintFailed"]),
		message: Schema.String,
	},
) {}

export class TinybirdOrgTokenService extends Context.Service<
	TinybirdOrgTokenService,
	TinybirdOrgTokenServiceShape
>()("@maple/api/services/TinybirdOrgTokenService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		// The scope allowlist is static per deploy — compute it once.
		const datasourceNames = listOrgScopedDatasourceNames()

		// Per-instance (per-isolate) cache. `expiresAt` is the re-mint deadline in ms.
		const cache = new Map<string, { token: string; expiresAt: number }>()

		const getOrgReadToken = Effect.fn("TinybirdOrgTokenService.getOrgReadToken")(function* (
			orgId: OrgId,
		) {
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && cached.expiresAt > nowMs) {
				yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", true)
				return cached.token
			}
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", false)
			if (Option.isNone(env.TINYBIRD_SIGNING_KEY)) {
				return yield* new TinybirdOrgTokenError({
					reason: "MissingSigningKey",
					message: "TINYBIRD_SIGNING_KEY is required for Tinybird-scoped raw SQL",
				})
			}
			if (Option.isNone(env.TINYBIRD_WORKSPACE_ID) || env.TINYBIRD_WORKSPACE_ID.value.trim() === "") {
				return yield* new TinybirdOrgTokenError({
					reason: "MissingWorkspaceId",
					message: "TINYBIRD_WORKSPACE_ID is required for Tinybird-scoped raw SQL",
				})
			}
			const workspaceId = env.TINYBIRD_WORKSPACE_ID.value
			const signingKey = Redacted.value(env.TINYBIRD_SIGNING_KEY.value)
			if (signingKey.trim() === "") {
				return yield* new TinybirdOrgTokenError({
					reason: "MissingSigningKey",
					message: "TINYBIRD_SIGNING_KEY must not be empty",
				})
			}
			const token = yield* Effect.try({
				try: () =>
					mintOrgReadJwt({
						signingKey,
						workspaceId,
						orgId,
						datasourceNames,
						nowSeconds: Math.floor(nowMs / 1000),
						ttlSeconds: JWT_TTL_SECONDS,
					}),
				catch: () =>
					new TinybirdOrgTokenError({
						reason: "MintFailed",
						message: "Failed to mint the Tinybird org-scoped read token",
					}),
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
