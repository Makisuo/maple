import { Result, useAtomValue } from "@/lib/effect-atom"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

/**
 * Whether the current user holds an org-admin role — the gate the API applies to
 * admin-only operations (`requireAdmin` in `apps/api/src/lib/auth.ts`). Reads the
 * same session atom the settings nav uses, so the two never disagree.
 *
 * Self-hosted (non-Clerk) deployments run as a single root user: always admin.
 * Defaults to `false` while the session is loading, so a gated control stays
 * disabled until we know the answer rather than flickering enabled.
 */
export function useIsOrgAdmin(): boolean {
	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))

	if (!isClerkAuthEnabled) return true

	return Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)
}
