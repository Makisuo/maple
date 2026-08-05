import { useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

/**
 * Reads a per-org rollout flag off the organization's Clerk publicMetadata.
 *
 * Always enabled in dev/local, or when Clerk auth is disabled (self-hosted).
 * In production with Clerk, requires `<flag>: true` on the org's
 * publicMetadata. Stays `false` until Clerk has loaded, so a gated surface
 * never flashes before the flag resolves.
 */
export function useOrgFeatureFlag(flag: string): boolean {
	if (import.meta.env.DEV) return true
	if (!isClerkAuthEnabled) return true

	// Guarded by the build-time `isClerkAuthEnabled` constant above: in
	// self-hosted builds there is no ClerkProvider, so calling this hook
	// unconditionally would crash. The branch is statically resolved per build.
	// oxlint-disable-next-line react-doctor/rules-of-hooks
	const { organization, isLoaded } = useOrganization()
	if (!isLoaded) return false

	return organization?.publicMetadata?.[flag] === true
}
