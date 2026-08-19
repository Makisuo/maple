// SQL catalog for the integration query builders.
//
// The core package's catalog cannot cover these: `@maple/query-engine` must not
// import this package (the dependency runs one way), so the fixtures live with
// the builders instead. Same contract as the core catalog — compile the REAL
// exported builder with production-shaped params, so every SQL shape the
// product can emit is enumerated and snapshotted.

import { compile, compileUnion, type CompiledQuery } from "@maple/query-engine/ch"
import * as CH from "./index"

export interface IntegrationFixture {
	/** Source module basename, e.g. `"cloudflare-infra"`. */
	readonly module: string
	/** The exported builder this covers — must match the export name. */
	readonly name: string
	/** Distinguishes fixtures for one builder; appears in failure output. */
	readonly label: string
	readonly compile: () => CompiledQuery<unknown>
}

const ORG_ID = "org_sql_catalog"
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

export const integrationFixtures: ReadonlyArray<IntegrationFixture> = [
	{
		module: "ai-sessions",
		name: "aiSessionListQuery",
		label: "default",
		compile: () => compile(CH.aiSessionListQuery(), window),
	},
	{
		// The vendor/service filters the AI sessions list page sends.
		module: "ai-sessions",
		name: "aiSessionListQuery",
		label: "filtered",
		compile: () =>
			compile(
				CH.aiSessionListQuery({
					limit: 25,
					vendorIds: ["eve"],
					serviceNames: ["maple-slack-agent"],
				}),
				window,
			),
	},
	{
		module: "ai-sessions",
		name: "aiSessionSpansQuery",
		label: "default",
		compile: () => compile(CH.aiSessionSpansQuery(), { ...window, sessionId: "wrun_sql_catalog" }),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneLatencySQL",
		label: "default",
		compile: () => compile(CH.cloudflareZoneLatencySQL(), window),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneTimeseriesSQL",
		label: "default",
		compile: () => compile(CH.cloudflareZoneTimeseriesSQL(), { ...window, bucketSeconds: 300 }),
	},
	{
		// Filters exercise the zone-slice predicates the /infra/cloudflare page sends.
		module: "cloudflare-infra",
		name: "cloudflareZoneTimeseriesSQL",
		label: "filtered",
		compile: () =>
			compile(
				CH.cloudflareZoneTimeseriesSQL({
					hosts: ["example.com"],
					statusClasses: ["5xx"],
					methods: ["GET"],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareQueueGaugesSQL",
		label: "default",
		compile: () => compile(CH.cloudflareQueueGaugesSQL(), window),
	},
	{
		module: "cloudflare-infra-breakdowns",
		name: "cloudflareZoneBreakdownTimeseriesSQL",
		label: "default",
		compile: () =>
			compile(CH.cloudflareZoneBreakdownTimeseriesSQL("path", {}, ["/api/v2/traces"]), {
				...window,
				serviceName: "cloudflare-zone-example-com",
				bucketSeconds: 300,
			}),
	},
	{
		module: "cloudflare-usage",
		name: "cloudflareUsageQuery",
		label: "default",
		compile: () => compile(CH.cloudflareUsageQuery(), { ...window, bucketSeconds: 3600 }),
	},
	{
		module: "cloudflare-map",
		name: "cloudflareServiceLatencySQL",
		label: "default",
		compile: () => compile(CH.cloudflareServiceLatencySQL(), window),
	},
	{
		module: "planetscale-map",
		name: "planetscaleGaugesSQL",
		label: "default",
		compile: () => compile(CH.planetscaleGaugesSQL(), window),
	},
]

export interface IntegrationCatalogEntry {
	readonly id: string
	readonly sql: string
	readonly compiled: CompiledQuery<unknown>
}

/** Compile every fixture. A fixture that throws fails here, not in production. */
export function collectIntegrationCatalog(): ReadonlyArray<IntegrationCatalogEntry> {
	return integrationFixtures.map((fixture) => {
		const compiled = fixture.compile()
		// The executor dies on unresolved placeholders at runtime; a fixture
		// missing a compile param must fail HERE.
		if (compiled.sql.includes("__PARAM_")) {
			throw new Error(
				`Integration catalog: ${fixture.module}/${fixture.name} (${fixture.label}) ` +
					`left an unresolved __PARAM_ placeholder — a compile param is missing.`,
			)
		}
		return {
			id: `builder:${fixture.module}:${fixture.name}:${fixture.label}`,
			sql: compiled.sql,
			compiled,
		}
	})
}
