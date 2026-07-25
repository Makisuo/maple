/**
 * Apply Maple's ClickHouse migrations to a target server.
 *
 * Mirrors the runtime logic in
 * `apps/api/src/services/OrgClickHouseSettingsService.ts:applySchema` —
 * idempotent (every CREATE has `IF NOT EXISTS`), tracks applied versions in
 * `_maple_schema_migrations`, qualifies every statement with the target
 * database via `qualifyStatementForDatabase`. Lives here so airgapped
 * customers can apply the schema without booting the Maple API.
 */

import {
	expandMigrationToSteps,
	clickHouseSchemaFeatures,
	featureSupportedByVersion,
	migrations as clickHouseMigrations,
	renderStatementFull,
} from "@maple/domain/clickhouse"
import { exec, type ClickHouseConfig } from "./client"

const MIGRATIONS_TABLE = "_maple_schema_migrations"
const FEATURES_TABLE = "_maple_schema_features"

interface AppliedRow {
	readonly version: number
	readonly applied_at: string
	readonly description: string
}

/** All bundled migrations, in version order. */
export const bundledMigrations = clickHouseMigrations

export interface ApplyResult {
	readonly applied: ReadonlyArray<{ version: number; description: string }>
	readonly skipped: ReadonlyArray<{ version: number; description: string }>
	readonly appliedFeatures: ReadonlyArray<{ id: string; description: string }>
	readonly skippedFeatures: ReadonlyArray<{ id: string; description: string; reason: string }>
}

export interface SchemaFeaturePlan {
	readonly id: string
	readonly description: string
	readonly state: "pending" | "unsupported"
	readonly reason?: string
	readonly statements: ReadonlyArray<string>
}

/**
 * Apply any unapplied migrations to the target server. Already-applied
 * migrations are skipped. Returns a summary so the caller can render a
 * sensible CLI report.
 */
export async function applyMigrations(config: ClickHouseConfig): Promise<ApplyResult> {
	await ensureMigrationsTable(config)
	await ensureFeaturesTable(config)
	const appliedVersions = await readAppliedVersions(config)

	const applied: Array<{ version: number; description: string }> = []
	const skipped: Array<{ version: number; description: string }> = []
	const appliedFeatures: Array<{ id: string; description: string }> = []
	const skippedFeatures: Array<{ id: string; description: string; reason: string }> = []

	for (const migration of bundledMigrations) {
		if (appliedVersions.has(migration.version)) {
			skipped.push({ version: migration.version, description: migration.description })
			continue
		}
		// Expand backfills into day-window chunks so a single huge INSERT…SELECT
		// never holds one connection for minutes (which also trips port-forward /
		// proxy idle timeouts). Structural DDL stays 1:1.
		const steps = await expandMigrationToSteps(migration, config.database, (sql) => exec(config, sql))
		for (const step of steps) {
			await exec(config, step.sql)
		}
		await recordMigration(config, migration.version, migration.description)
		applied.push({ version: migration.version, description: migration.description })
	}

	const serverVersion = (await exec(config, "SELECT version() FORMAT TabSeparated")).trim()
	const appliedFeatureRevisions = await readAppliedFeatureRevisions(config)
	for (const feature of clickHouseSchemaFeatures) {
		if (!featureSupportedByVersion(feature, serverVersion)) {
			skippedFeatures.push({
				id: feature.id,
				description: feature.description,
				reason: `requires ClickHouse ${feature.minClickHouseVersion}+`,
			})
			continue
		}
		if ((appliedFeatureRevisions.get(feature.id) ?? 0) >= feature.revision) {
			skippedFeatures.push({
				id: feature.id,
				description: feature.description,
				reason: "already present",
			})
			continue
		}

		let satisfied = false
		if (feature.satisfiedBySortingKey) {
			const table = feature.satisfiedBySortingKey.table.replace(/'/g, "''")
			const result = await exec(
				config,
				`SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = '${table}' FORMAT JSONEachRow`,
			)
			const row = parseJsonEachRow<{ sorting_key?: string }>(result)[0]
			satisfied =
				normalizeExpression(row?.sorting_key ?? "") ===
				normalizeExpression(feature.satisfiedBySortingKey.expected)
		}
		if (!satisfied) {
			for (const statement of feature.statements) {
				await exec(config, statement)
			}
		}
		await recordFeature(config, feature.id, feature.revision, feature.description)
		appliedFeatures.push({ id: feature.id, description: feature.description })
	}

	return { applied, skipped, appliedFeatures, skippedFeatures }
}

/**
 * Diff bundled vs already-applied versions without writing anything.
 */
export async function pendingMigrations(
	config: ClickHouseConfig,
): Promise<ReadonlyArray<{ version: number; description: string }>> {
	const applied = await readAppliedVersions(config).catch((err) => {
		// If the bookkeeping table doesn't exist, NO migrations have been
		// applied yet — every bundled one is pending.
		if (err instanceof Error && /UNKNOWN_TABLE|doesn't exist/i.test(err.message)) {
			return new Set<number>()
		}
		throw err
	})
	return bundledMigrations
		.filter((m) => !applied.has(m.version))
		.map((m) => ({ version: m.version, description: m.description }))
}

/**
 * Read-only reconciliation plan for performance features. An absent feature
 * bookkeeping table means every supported feature is pending.
 */
export async function pendingSchemaFeatures(
	config: ClickHouseConfig,
): Promise<ReadonlyArray<SchemaFeaturePlan>> {
	const serverVersion = (await exec(config, "SELECT version() FORMAT TabSeparated")).trim()
	const applied = await readAppliedFeatureRevisions(config).catch((err) => {
		if (err instanceof Error && /UNKNOWN_TABLE|doesn't exist/i.test(err.message)) {
			return new Map<string, number>()
		}
		throw err
	})
	const plan: SchemaFeaturePlan[] = []

	for (const feature of clickHouseSchemaFeatures) {
		if (!featureSupportedByVersion(feature, serverVersion)) {
			plan.push({
				id: feature.id,
				description: feature.description,
				state: "unsupported",
				reason: `requires ClickHouse ${feature.minClickHouseVersion}+`,
				statements: [],
			})
			continue
		}
		if ((applied.get(feature.id) ?? 0) >= feature.revision) continue

		let satisfied = false
		if (feature.satisfiedBySortingKey) {
			const table = feature.satisfiedBySortingKey.table.replace(/'/g, "''")
			const result = await exec(
				config,
				`SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = '${table}' FORMAT JSONEachRow`,
			)
			const row = parseJsonEachRow<{ sorting_key?: string }>(result)[0]
			satisfied =
				normalizeExpression(row?.sorting_key ?? "") ===
				normalizeExpression(feature.satisfiedBySortingKey.expected)
		}
		plan.push({
			id: feature.id,
			description: feature.description,
			state: "pending",
			reason: satisfied ? "sorting key already satisfies this feature; bookkeeping only" : undefined,
			statements: satisfied ? [] : feature.statements,
		})
	}

	return plan
}

/**
 * Print every DDL statement that `applyMigrations` *would* run, without
 * executing anything. Useful for `--dry-run`. The bookkeeping INSERT is
 * elided (it's the same shape for every migration).
 */
export async function dryRun(
	config: ClickHouseConfig,
): Promise<ReadonlyArray<{ version: number; statements: ReadonlyArray<string> }>> {
	const pending = new Set((await pendingMigrations(config)).map((m) => m.version))
	const out: Array<{ version: number; statements: ReadonlyArray<string> }> = []
	for (const migration of bundledMigrations) {
		if (!pending.has(migration.version)) continue
		out.push({
			version: migration.version,
			statements: migration.statements.map((s) => renderStatementFull(s, config.database)),
		})
	}
	return out
}

/** Read the bookkeeping table directly. */
export async function listApplied(config: ClickHouseConfig): Promise<ReadonlyArray<AppliedRow>> {
	await ensureMigrationsTable(config)
	const text = await exec(
		config,
		`SELECT version, applied_at, description FROM ${quote(MIGRATIONS_TABLE)} ORDER BY version FORMAT JSONEachRow`,
	)
	return parseJsonEachRow<AppliedRow>(text)
}

// --- internals -------------------------------------------------------------

async function ensureMigrationsTable(config: ClickHouseConfig): Promise<void> {
	await exec(
		config,
		`CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (
			version UInt32,
			applied_at DateTime64(3) DEFAULT now64(3),
			description String
		) ENGINE = MergeTree ORDER BY version`,
	)
}

async function ensureFeaturesTable(config: ClickHouseConfig): Promise<void> {
	await exec(
		config,
		`CREATE TABLE IF NOT EXISTS ${quote(FEATURES_TABLE)} (
			id String,
			revision UInt32,
			applied_at DateTime64(3) DEFAULT now64(3),
			description String
		) ENGINE = ReplacingMergeTree(revision) ORDER BY id`,
	)
}

async function readAppliedVersions(config: ClickHouseConfig): Promise<Set<number>> {
	const text = await exec(config, `SELECT version FROM ${quote(MIGRATIONS_TABLE)} FORMAT JSONEachRow`)
	const rows = parseJsonEachRow<{ version: number }>(text)
	return new Set(rows.map((r) => r.version))
}

async function recordMigration(
	config: ClickHouseConfig,
	version: number,
	description: string,
): Promise<void> {
	const safeDescription = description.replace(/'/g, "''")
	await exec(
		config,
		`INSERT INTO ${quote(MIGRATIONS_TABLE)} (version, description) VALUES (${version}, '${safeDescription}')`,
	)
}

async function readAppliedFeatureRevisions(config: ClickHouseConfig): Promise<Map<string, number>> {
	const text = await exec(
		config,
		`SELECT id, max(revision) AS revision FROM ${quote(FEATURES_TABLE)} GROUP BY id FORMAT JSONEachRow`,
	)
	return new Map(
		parseJsonEachRow<{ id: string; revision: number | string }>(text).map((row) => [
			row.id,
			Number(row.revision),
		]),
	)
}

async function recordFeature(
	config: ClickHouseConfig,
	id: string,
	revision: number,
	description: string,
): Promise<void> {
	await exec(
		config,
		`INSERT INTO ${quote(FEATURES_TABLE)} (id, revision, description) VALUES ('${id.replace(/'/g, "''")}', ${revision}, '${description.replace(/'/g, "''")}')`,
	)
}

const normalizeExpression = (value: string): string =>
	value.replace(/`/g, "").replace(/\s+/g, "").toLowerCase()

function quote(name: string): string {
	return `\`${name.replace(/`/g, "``")}\``
}

function parseJsonEachRow<T>(text: string): ReadonlyArray<T> {
	const out: T[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			out.push(JSON.parse(trimmed) as T)
		} catch {
			// best-effort; the response is from us-controlled queries
		}
	}
	return out
}
