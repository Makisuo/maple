import { useOrgFeatureFlag } from "@/hooks/use-org-feature-flag"

/**
 * Gates the Agent Traces feature.
 *
 * Always enabled in dev/local, or when Clerk auth is disabled (self-hosted).
 * In production with Clerk, requires `agent_tracing: true` in the org's
 * publicMetadata.
 */
export function useAgentTracingEnabled(): boolean {
	return useOrgFeatureFlag("agent_tracing")
}
