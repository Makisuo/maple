import { useOrganization } from "@clerk/clerk-react"

import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	organizationFeatureFlagsFrom,
	type OrganizationFeatureFlags,
} from "@/lib/organization-feature-flags"

export interface OrganizationFeatureFlagsState {
	readonly flags: OrganizationFeatureFlags
	/**
	 * Whether `flags` is the organization's real answer yet.
	 *
	 * Load and disabled are separate states on purpose. Both leave `flags` all
	 * false, which is the right thing for hiding a nav row — nothing renders
	 * either way. But a *route* that treats them alike renders a definite negative
	 * ("Page not found") during the load window and then swaps to the real page,
	 * so an entitled org gets a not-found flash on every reload. Anything drawing a
	 * conclusion from a disabled flag must check this first.
	 */
	readonly isLoaded: boolean
}

/**
 * Clerk mode: rollout flags live in the organization's public metadata.
 *
 * `isLoaded` comes straight from Clerk — `organization` is `undefined` both while
 * loading and when there is genuinely no org, and only Clerk can tell those apart.
 */
function useClerkOrganizationFeatureFlags(): OrganizationFeatureFlagsState {
	const { organization, isLoaded } = useOrganization()
	return {
		flags: isLoaded
			? organizationFeatureFlagsFrom(organization?.publicMetadata)
			: DISABLED_ORGANIZATION_FEATURE_FLAGS,
		isLoaded,
	}
}

/** Self-hosted: nothing to load, and every rollout is on. Touches no Clerk hook. */
function useSelfHostedOrganizationFeatureFlags(): OrganizationFeatureFlagsState {
	return SELF_HOSTED_STATE
}

const SELF_HOSTED_STATE: OrganizationFeatureFlagsState = {
	flags: ENABLED_ORGANIZATION_FEATURE_FLAGS,
	isLoaded: true,
}

/**
 * The organization's rollout flags — the single way consumers read them, so the
 * three rules that make a flag safe live here instead of being re-derived per
 * call site.
 *
 * **Fail closed while loading.** Clerk has not answered yet, so no flagged
 * surface renders. Callers that draw a conclusion from "off" must gate on
 * `isLoaded` (see its doc comment).
 *
 * **Fail open when self-hosted.** There is no Clerk to read metadata from, and
 * treating that as "all flags off" would hide flagged features from self-hosters
 * permanently — a rollout flag is a tool for staging the managed product.
 *
 * **Never call a Clerk hook outside Clerk mode.** `apps/web/src/main.tsx` mounts
 * `ClerkProvider` only when `isClerkAuthEnabled`, and Clerk v5 hooks throw
 * without one. An `if (!isClerkAuthEnabled) return …` *inside* a hook is too late
 * — `useOrganization()` has already run and thrown. So the implementation is
 * chosen here at module scope, off a build-time constant: each variant calls its
 * hooks unconditionally, hook order is fixed for the lifetime of the bundle, and
 * the self-hosted build never reaches the Clerk one. This is the hook-level form
 * of the boundary `org-switcher.tsx` and `select-plan.tsx` draw at the component
 * level.
 */
export const useOrganizationFeatureFlags: () => OrganizationFeatureFlagsState = isClerkAuthEnabled
	? useClerkOrganizationFeatureFlags
	: useSelfHostedOrganizationFeatureFlags
