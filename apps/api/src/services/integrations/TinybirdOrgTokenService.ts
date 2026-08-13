import type { OrgId } from "@maple/domain"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { listOrgScopedDatasourceNames } from "@/services/warehouse/warehouse-catalog"
import { mintOrgReadJwt } from "@/services/auth/tinybird-jwt"
import { Env } from "@/platform/Env"

// TinybirdOrgTokenService — mints and caches per-org Tinybird read JWTs used to
// scope the raw-SQL path to a single org's rows (row-level security enforced by
// Tinybird server-side; see lib/tinybird-jwt.ts).
//
// A JWT is reused for its lifetime and re-minted on expiry. The cache entry
// expires SKEW seconds before the token itself, so a served token always has
// comfortably more life left than the executor's 30s client-cache TTL — a cached
// Tinybird client never outlives the JWT it was built with.

/** Token lifetime. */
const JWT_TTL_SECONDS = 600
/** Re-mint this many seconds before true expiry (must exceed the executor's 30s client cache). */
const JWT_REFRESH_SKEW_SECONDS = 60
/**
 * Each token carries one scope per OrgId-bearing datasource, so an unbounded
 * org map can consume meaningful isolate memory. Eviction only causes a cheap
 * local re-mint; it does not invalidate the previously issued JWT.
 */
export const JWT_CACHE_MAX_ENTRIES = 512

export interface TinybirdOrgTokenServiceShape {
	/** A Tinybird read JWT scoped to `orgId` across every OrgId-bearing datasource. */
	readonly getOrgReadToken: (
		orgId: OrgId,
	) => Effect.Effect<string, TinybirdOrgTokenConfigError | TinybirdOrgTokenMintError>
}

export class TinybirdOrgTokenConfigError extends Schema.TaggedError<TinybirdOrgTokenConfigError>()(
	"@maple/api/services/TinybirdOrgTokenConfigError",
	{
		setting: Schema.Literals(["SigningKey", "WorkspaceId"]),
		message: Schema.String,
	},
) {}

export class TinybirdOrgTokenMintError extends Schema.TaggedError<TinybirdOrgTokenMintError>()(
	"@maple/api/services/TinybirdOrgTokenMintError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
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
		const pruneCache = (nowMs: number) => {
			for (const [orgId, entry] of cache) {
				if (entry.expiresAt <= nowMs) cache.delete(orgId)
			}
			while (cache.size >= JWT_CACHE_MAX_ENTRIES) {
				const oldestOrgId = cache.keys().next().value
				if (oldestOrgId === undefined) break
				cache.delete(oldestOrgId)
			}
		}

		const getOrgReadToken = Effect.fn("TinybirdOrgTokenService.getOrgReadToken")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && cached.expiresAt > nowMs) {
				// Map iteration order is insertion order; refresh it on access so the
				// fixed-size cache evicts the least-recently-used org.
				cache.delete(orgId)
				cache.set(orgId, cached)
				yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", true)
				return cached.token
			}
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", false)
			pruneCache(nowMs)
			if (Option.isNone(env.TINYBIRD_SIGNING_KEY)) {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "SigningKey",
					message: "TINYBIRD_SIGNING_KEY is required for Tinybird-scoped raw SQL",
				})
			}
			if (Option.isNone(env.TINYBIRD_WORKSPACE_ID) || env.TINYBIRD_WORKSPACE_ID.value.trim() === "") {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "WorkspaceId",
					message: "TINYBIRD_WORKSPACE_ID is required for Tinybird-scoped raw SQL",
				})
			}
			const workspaceId = env.TINYBIRD_WORKSPACE_ID.value
			const signingKey = Redacted.value(env.TINYBIRD_SIGNING_KEY.value)
			if (signingKey.trim() === "") {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "SigningKey",
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
						rpsLimit: Option.getOrUndefined(env.TINYBIRD_RAW_SQL_JWT_RPS_LIMIT),
					}),
				catch: (cause) =>
					new TinybirdOrgTokenMintError({
						message: "Failed to mint the Tinybird org-scoped read token",
						cause,
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
