import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { format } from "oxfmt"
import { emitJsonPathSpec } from "../packages/domain/src/clickhouse/ddl-emitter"
import { clickHouseSchemaVersion } from "../packages/domain/src/clickhouse/migrations"
import { projectRevision as clickHouseProjectRevision } from "../packages/domain/src/generated/clickhouse-schema"
import { buildTinybirdProjectManifest } from "../packages/domain/src/tinybird/project-manifest"

// Datasources the local OTLP ingest path actually writes. session_* (replay
// ingest) and alert_checks (alerting engine) are written by subsystems the
// lightweight local binary does not run, so they are out of scope here.
const OTLP_DATASOURCES = [
	"traces",
	"logs",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
] as const

const INGEST_DATASOURCES = [
	...OTLP_DATASOURCES,
	"session_replays",
	"session_replay_events",
	"session_events",
] as const

// Replaced by the Rust binary with the pinned, escaped org-id string literal.
const ORG_PLACEHOLDER = "__ORG__"

const localOutputPath = fileURLToPath(
	new URL("../apps/cli/src/server/schema/local-inserts.json", import.meta.url),
)
const rustOutputPath = fileURLToPath(
	new URL("../apps/ingest/src/clickhouse_insert_mappings.rs", import.meta.url),
)
const checkMode = process.argv.includes("--check")

interface DatasourceMapping {
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly selects: ReadonlyArray<string>
	readonly inputSchema: string
}

const manifest = await buildTinybirdProjectManifest()
const byName = new Map(manifest.datasources.map((ds) => [ds.name, ds]))

const localDatasources: Record<string, DatasourceMapping> = {}
for (const name of OTLP_DATASOURCES) {
	const ds = byName.get(name)
	if (!ds) {
		throw new Error(`OTLP datasource "${name}" not found in Tinybird manifest`)
	}
	localDatasources[name] = buildMapping(name, emitJsonPathSpec(ds))
}

const ingestDatasources: Record<string, DatasourceMapping> = {}
for (const name of INGEST_DATASOURCES) {
	const ds = byName.get(name)
	if (!ds) {
		throw new Error(`ingest datasource "${name}" not found in Tinybird manifest`)
	}
	ingestDatasources[name] = buildMapping(name, emitJsonPathSpec(ds))
}

const renderedLocalSource = `${JSON.stringify(
	{
		projectRevision: clickHouseProjectRevision,
		orgPlaceholder: ORG_PLACEHOLDER,
		datasources: localDatasources,
	},
	null,
	2,
)}\n`
const renderedLocalResult = await format(localOutputPath, renderedLocalSource, {
	printWidth: 110,
	tabWidth: 4,
	useTabs: true,
})
if (renderedLocalResult.errors.length > 0) {
	throw new Error(
		`Failed to format generated local insert mappings: ${renderedLocalResult.errors[0]!.message}`,
	)
}
const renderedLocal = renderedLocalResult.code

const renderedRust = renderRustMappings(clickHouseProjectRevision, ingestDatasources)

let existingLocal = ""
try {
	existingLocal = readFileSync(localOutputPath, "utf8")
} catch {
	existingLocal = ""
}

let existingRust = ""
try {
	existingRust = readFileSync(rustOutputPath, "utf8")
} catch {
	existingRust = ""
}

if (checkMode) {
	let ok = true
	if (existingLocal !== renderedLocal) {
		console.error("local-inserts.json is out of date. Run `bun run clickhouse:schema`.")
		ok = false
	}
	if (existingRust !== renderedRust) {
		console.error("clickhouse_insert_mappings.rs is out of date. Run `bun run clickhouse:schema`.")
		ok = false
	}
	if (!ok) {
		process.exit(1)
	}
	console.log(
		`ClickHouse insert mappings are up to date (${clickHouseProjectRevision}, ${OTLP_DATASOURCES.length} local datasources, ${INGEST_DATASOURCES.length} ingest datasources).`,
	)
} else {
	mkdirSync(dirname(localOutputPath), { recursive: true })
	writeFileSync(localOutputPath, renderedLocal)
	mkdirSync(dirname(rustOutputPath), { recursive: true })
	writeFileSync(rustOutputPath, renderedRust)
	console.log(
		`Wrote ClickHouse insert mappings (${clickHouseProjectRevision}, ${OTLP_DATASOURCES.length} local datasources, ${INGEST_DATASOURCES.length} ingest datasources).`,
	)
}

function buildMapping(
	table: string,
	spec: ReadonlyArray<{ column: string; type: string; jsonPath: string | null }>,
): DatasourceMapping {
	const columns: string[] = []
	const selects: string[] = []
	const inputFields: string[] = []
	// Two columns can map to the same JSON leaf (e.g. logs `Timestamp` and
	// `TimestampTime` both read `$.timestamp`). The `format()` structure must
	// declare each leaf once — but the SELECT may reference it for several
	// target columns. Track the first type seen per leaf and skip duplicates in
	// the input schema only.
	const seenLeaves = new Set<string>()

	for (const { column, type, jsonPath } of spec) {
		if (column === "OrgId") {
			// Single-tenant local mode pins OrgId; never extracted from JSON.
			columns.push(column)
			selects.push(ORG_PLACEHOLDER)
			continue
		}
		if (jsonPath === null || jsonPath === `$.${column}`) {
			// No JSON path, or a PascalCase-identity path (a computed DEFAULT/
			// MATERIALIZED column the gateway never emits, e.g. SampleRate,
			// IsEntryPoint). Omit so the table's DEFAULT expression computes it.
			continue
		}
		const leaf = jsonLeaf(table, column, jsonPath)
		columns.push(column)
		selects.push(leaf)
		if (!seenLeaves.has(leaf)) {
			seenLeaves.add(leaf)
			inputFields.push(`${leaf} ${type}`)
		}
	}

	return { table, columns, selects, inputSchema: inputFields.join(", ") }
}

function jsonLeaf(table: string, column: string, jsonPath: string): string {
	// Accept `$.field` and `$.field[:]` (array). Anything else is a nested or
	// expression path we don't auto-map for local ingest.
	const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)(\[:\])?$/.exec(jsonPath)
	if (!match) {
		throw new Error(
			`Unsupported jsonPath "${jsonPath}" for ${table}.${column}; generator only handles top-level $.field and $.field[:] paths.`,
		)
	}
	return match[1] as string
}

function renderRustMappings(revision: string, datasources: Record<string, DatasourceMapping>): string {
	const entries = Object.entries(datasources)
	const lines: string[] = [
		"// This file is generated by scripts/generate-clickhouse-insert-mappings.ts",
		"// Do not edit manually.",
		"",
		`pub const PROJECT_REVISION: &str = ${rustString(revision)};`,
		`// Gate for BYO-ClickHouse ingest readiness — the migration version, NOT the`,
		`// Tinybird-coupled PROJECT_REVISION. Compared against`,
		`// org_clickhouse_settings.schema_version. See @maple/domain/clickhouse`,
		`// clickHouseSchemaVersion.`,
		`pub const SCHEMA_VERSION: &str = ${rustString(clickHouseSchemaVersion)};`,
		`pub const ORG_PLACEHOLDER: &str = ${rustString(ORG_PLACEHOLDER)};`,
		"",
		"#[derive(Debug)]",
		"pub struct InsertMapping {",
		"    pub datasource: &'static str,",
		"    pub table: &'static str,",
		"    pub columns: &'static [&'static str],",
		"    pub selects: &'static [&'static str],",
		"    pub input_schema: &'static str,",
		"}",
		"",
		"pub const DATASOURCES: &[InsertMapping] = &[",
	]
	for (const [datasource, mapping] of entries) {
		lines.push("    InsertMapping {")
		lines.push(`        datasource: ${rustString(datasource)},`)
		lines.push(`        table: ${rustString(mapping.table)},`)
		lines.push(`        columns: ${rustStringArray(mapping.columns)},`)
		lines.push(`        selects: ${rustStringArray(mapping.selects)},`)
		lines.push(`        input_schema: ${rustString(mapping.inputSchema)},`)
		lines.push("    },")
	}
	lines.push("];")
	lines.push("")
	lines.push("pub fn mapping_for(datasource: &str) -> Option<&'static InsertMapping> {")
	lines.push("    match datasource {")
	entries.forEach(([datasource], index) => {
		lines.push(`        ${rustString(datasource)} => Some(&DATASOURCES[${index}]),`)
	})
	lines.push("        _ => None,")
	lines.push("    }")
	lines.push("}")
	lines.push("")
	return `${lines.join("\n")}\n`
}

function rustString(value: string): string {
	return JSON.stringify(value)
}

function rustStringArray(values: ReadonlyArray<string>): string {
	return `&[${values.map(rustString).join(", ")}]`
}
