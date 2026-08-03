import { Option, Schema } from "effect"

/**
 * Shape of the `discovery_config_json` column on `planetscale`-type scrape
 * targets — the single schema behind ScrapeTargetsService (write + read),
 * PlanetScaleConnectionService (status/adoption reads), and
 * PlanetScaleDiscoveryService (branch filters), so the shapes can't drift.
 */
export const DiscoveryConfigSchema = Schema.Struct({
	organization: Schema.String,
	includeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	excludeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type DiscoveryConfig = typeof DiscoveryConfigSchema.Type

const decodeOption = Schema.decodeUnknownOption(DiscoveryConfigSchema)

/** Lenient read: unset or malformed config decodes to `null` (legacy rows). */
export const decodeDiscoveryConfig = (json: unknown): DiscoveryConfig | null =>
	json ? Option.getOrNull(decodeOption(json)) : null
