import { apiKeys, mcpOAuthRefreshTokens } from "@maple/db"
import type { MapleDatabaseTransaction } from "@maple/db/client"
import type { ApiKeyId, OrgId, UserId } from "@maple/domain/http"
import { and, eq, inArray, isNull } from "drizzle-orm"

/**
 * Refresh-family revocation, shared rather than private to `McpOAuthService`.
 *
 * A family is the durable half of an MCP grant: the visible `api_keys` row is
 * re-minted hourly, so flipping `revoked` on it alone is a no-op the next
 * rotation undoes. Every path that ends a grant — reuse detection, the OAuth
 * revocation endpoint, the API-keys UI, and a member losing their membership —
 * has to come through here.
 */

/** Revoke a whole family and every access key it has ever minted. */
export const revokeRefreshFamily = async (
	tx: MapleDatabaseTransaction,
	familyId: string,
	now: Date,
): Promise<void> => {
	const family = await tx
		.select({ accessKeyId: mcpOAuthRefreshTokens.accessKeyId })
		.from(mcpOAuthRefreshTokens)
		.where(eq(mcpOAuthRefreshTokens.familyId, familyId))
	await tx
		.update(mcpOAuthRefreshTokens)
		.set({ revokedAt: now })
		.where(and(eq(mcpOAuthRefreshTokens.familyId, familyId), isNull(mcpOAuthRefreshTokens.revokedAt)))
	const accessKeyIds = family.map((item) => item.accessKeyId)
	if (accessKeyIds.length > 0) {
		await tx
			.update(apiKeys)
			.set({ revoked: true, revokedAt: now })
			.where(inArray(apiKeys.id, accessKeyIds))
	}
}

/**
 * Revoke every family reachable from these access-key ids. This is the bridge
 * from "the user revoked the key they can see" to "the grant behind it dies".
 */
export const revokeFamiliesForAccessKeys = async (
	tx: MapleDatabaseTransaction,
	accessKeyIds: ReadonlyArray<ApiKeyId>,
	now: Date,
): Promise<number> => {
	if (accessKeyIds.length === 0) return 0
	const rows = await tx
		.select({ familyId: mcpOAuthRefreshTokens.familyId })
		.from(mcpOAuthRefreshTokens)
		.where(inArray(mcpOAuthRefreshTokens.accessKeyId, [...accessKeyIds]))
	const familyIds = [...new Set(rows.map((row) => row.familyId))]
	for (const familyId of familyIds) await revokeRefreshFamily(tx, familyId, now)
	return familyIds.length
}

/** Revoke every family a user holds in one organization, or in all of them when `orgId` is null. */
export const revokeRefreshFamiliesForMember = async (
	tx: MapleDatabaseTransaction,
	orgId: OrgId | null,
	userId: UserId,
	now: Date,
): Promise<number> => {
	const rows = await tx
		.select({ familyId: mcpOAuthRefreshTokens.familyId })
		.from(mcpOAuthRefreshTokens)
		.where(
			and(
				...(orgId === null ? [] : [eq(mcpOAuthRefreshTokens.orgId, orgId)]),
				eq(mcpOAuthRefreshTokens.userId, userId),
			),
		)
	const familyIds = [...new Set(rows.map((row) => row.familyId))]
	for (const familyId of familyIds) await revokeRefreshFamily(tx, familyId, now)
	return familyIds.length
}
