import { Effect, Option, Schema, SchemaGetter } from "effect"

/**
 * Clerk public metadata is untrusted JSON. A rollout flag is enabled only by
 * the literal boolean `true`; missing and malformed values remain disabled.
 */
const DisabledByDefaultFeatureFlag = Schema.Unknown.pipe(
	Schema.decodeTo(Schema.Boolean, {
		decode: SchemaGetter.transform((value: unknown) => value === true),
		encode: SchemaGetter.passthrough<boolean>(),
	}),
	Schema.withDecodingDefaultKey(Effect.succeed(false)),
)

/**
 * The single contract for organization-scoped rollout flags stored in Clerk.
 * Decoded consumers use product-facing camelCase names; encoded keys match
 * Clerk's public metadata exactly.
 */
export const OrganizationFeatureFlags = Schema.Struct({
	aiAutoTriage: DisabledByDefaultFeatureFlag,
	webAnalytics: DisabledByDefaultFeatureFlag,
}).pipe(
	Schema.encodeKeys({
		aiAutoTriage: "aiautotriage",
		webAnalytics: "webanalytics",
	}),
)

export type OrganizationFeatureFlags = Schema.Schema.Type<typeof OrganizationFeatureFlags>

const decodeOrganizationFeatureFlags = Schema.decodeUnknownOption(OrganizationFeatureFlags)

const DISABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: false,
	webAnalytics: false,
}

/**
 * Every rollout on, for the self-hosted build where there is no Clerk to read
 * metadata from. Mirrors how `settings-nav` treats `!isClerkAuthEnabled`: a flag
 * is a staged-rollout tool for the managed product, and leaving them all off
 * would permanently hide the features from anyone running Maple themselves.
 */
export const ENABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: true,
	webAnalytics: true,
}

/** Decode Clerk metadata, falling back to every rollout disabled for non-object input. */
export function organizationFeatureFlagsFrom(metadata: unknown): OrganizationFeatureFlags {
	return Option.getOrElse(
		decodeOrganizationFeatureFlags(metadata),
		() => DISABLED_ORGANIZATION_FEATURE_FLAGS,
	)
}
