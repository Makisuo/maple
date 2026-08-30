/**
 * Tables Maple serves as ElectricSQL shapes. Keep this list in step with the
 * drizzle publication migrations (0009 / 0011 / 0014 / 0022 prune / 0037) and
 * with `apps/electric-sync` shape names. `ensure-electric-publication.ts` and
 * the bundled-migration test both import it so a YAML Job cannot drift.
 */
export const ELECTRIC_PUBLICATION = "electric_publication_default"

export const ELECTRIC_SYNCED_TABLES = [
	"dashboards",
	"alert_rules",
	"alert_rule_states",
	"alert_incidents",
	"alert_destinations",
	"api_keys",
	"investigations",
	"investigation_lens_runs",
] as const

/** Published by 0009/0011, then dropped by 0022 once client collections went away. */
export const ELECTRIC_UNSYNCED_TABLES = [
	"error_issues",
	"actors",
	"error_incidents",
	"scrape_target_checks",
] as const
