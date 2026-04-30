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
	migrations as clickHouseMigrations,
	qualifyStatementForDatabase,
} from "@maple/domain/clickhouse"
import { exec, type ClickHouseConfig } from "./client"

const MIGRATIONS_TABLE = "_maple_schema_migrations"

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
}

/**
 * Apply any unapplied migrations to the target server. Already-applied
 * migrations are skipped. Returns a summary so the caller can render a
 * sensible CLI report.
 */
export async function applyMigrations(config: ClickHouseConfig): Promise<ApplyResult> {
	await ensureMigrationsTable(config)
	const appliedVersions = await readAppliedVersions(config)

	const applied: Array<{ version: number; description: string }> = []
	const skipped: Array<{ version: number; description: string }> = []

	for (const migration of bundledMigrations) {
		if (appliedVersions.has(migration.version)) {
			skipped.push({ version: migration.version, description: migration.description })
			continue
		}
		for (const stmt of migration.statements) {
			await exec(config, qualifyStatementForDatabase(stmt, config.database))
		}
		await recordMigration(config, migration.version, migration.description)
		applied.push({ version: migration.version, description: migration.description })
	}

	return { applied, skipped }
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
			statements: migration.statements.map((s) => qualifyStatementForDatabase(s, config.database)),
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

async function readAppliedVersions(config: ClickHouseConfig): Promise<Set<number>> {
	const text = await exec(
		config,
		`SELECT version FROM ${quote(MIGRATIONS_TABLE)} FORMAT JSONEachRow`,
	)
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
