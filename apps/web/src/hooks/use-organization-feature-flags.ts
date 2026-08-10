import { useOrganization } from "@clerk/clerk-react"

import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import {
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	organizationFeatureFlagsFrom,
	type OrganizationFeatureFlags,
} from "@/lib/organization-feature-flags"

/**
 * The organization's rollout flags, read from Clerk public metadata.
 *
 * Every consumer goes through here rather than calling
 * `organizationFeatureFlagsFrom(organization?.publicMetadata)` inline, so the
 * two rules that make a flag safe live in one place instead of being re-derived
 * per call site:
 *
 * 1. **Fail closed on the managed product.** `organizationFeatureFlagsFrom`
 *    already returns everything disabled for missing or malformed metadata, and
 *    `useOrganization()` returns `undefined` while Clerk is still loading — so a
 *    flagged surface stays hidden during that window rather than flashing into
 *    view and then disappearing.
 * 2. **Fail open when self-hosted.** `isClerkAuthEnabled` is a build-time
 *    constant; with no Clerk there is no metadata to read, and treating that as
 *    "all flags off" would permanently hide flagged features from anyone running
 *    Maple themselves. `settings-nav` already made this call for `aiAutoTriage`;
 *    this keeps the two from disagreeing.
 */
export function useOrganizationFeatureFlags(): OrganizationFeatureFlags {
	const { organization } = useOrganization()
	if (!isClerkAuthEnabled) return ENABLED_ORGANIZATION_FEATURE_FLAGS
	return organizationFeatureFlagsFrom(organization?.publicMetadata)
}
