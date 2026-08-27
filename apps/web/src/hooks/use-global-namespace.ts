import { useSyncExternalStore } from "react"
import { getGlobalNamespace, subscribeGlobalNamespace } from "@/lib/services/common/global-namespace"

/** The active org's pinned service.namespace, or null for "All namespaces". */
export const useGlobalNamespace = (): string | null =>
	useSyncExternalStore(subscribeGlobalNamespace, getGlobalNamespace, () => null)
