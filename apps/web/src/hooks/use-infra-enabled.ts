import { useOrgFeatureFlag } from "@/hooks/use-org-feature-flag"

/**
 * Gates the Infrastructure feature.
 *
 * Always enabled in dev/local, or when Clerk auth is disabled (self-hosted).
 * In production with Clerk, requires `infra_monitoring: true` in the org's
 * publicMetadata.
 */
export function useInfraEnabled(): boolean {
	return useOrgFeatureFlag("infra_monitoring")
}
