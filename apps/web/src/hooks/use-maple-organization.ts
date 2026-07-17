import { useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

function useClerkOrganizationId() {
	const { organization } = useOrganization()
	return organization?.id ?? null
}

function useLocalOrganizationId() {
	return "default"
}

/**
 * The auth mode is fixed for the lifetime of the bundle, so choose the hook
 * implementation once at module initialization. Each implementation then has
 * an invariant hook order of its own.
 */
export const useMapleOrganizationId = isClerkAuthEnabled ? useClerkOrganizationId : useLocalOrganizationId
