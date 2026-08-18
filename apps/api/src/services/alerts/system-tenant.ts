/**
 * The tenant the alerting system reads warehouse data as.
 *
 * Alert evaluation, the checks read model and the public chart image all query
 * on behalf of a schedule or a signed URL rather than a signed-in person, so
 * there is no viewer whose tenant they could use. Each of them had grown its
 * own identical copy of this, which is three places to keep a `root`-roled
 * identity in step.
 *
 * It grants nothing on its own: every query still filters `OrgId`, and the org
 * comes from the rule row or the signed claims, never from the caller.
 */
import { RoleName, UserId as UserIdSchema, type OrgId } from "@maple/domain/http"
import { Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"

const decodeRoleName = Schema.decodeUnknownSync(RoleName)
const decodeUserId = Schema.decodeUnknownSync(UserIdSchema)

const SYSTEM_USER_ID = decodeUserId("system-alerting")
const SYSTEM_ROLES = [decodeRoleName("root")]

export const systemTenant = (orgId: OrgId): TenantContext => ({
	orgId,
	userId: SYSTEM_USER_ID,
	roles: SYSTEM_ROLES,
	authMode: "self_hosted",
})
