/**
 * Schema-apply workflow logic (heavy import graph lives here, NOT in the thin
 * class shell, so the worker's module scope stays light — see the dynamic import
 * in `ClickHouseSchemaApplyWorkflow.ts` and the `buildHandler` note in
 * `apps/api/src/worker.ts`).
 *
 * Runs Maple's ClickHouse migrations against a customer's BYO cluster, splitting
 * each backfill into day-window chunks (one durable `step.do` each) so no single
 * statement exceeds the Worker subrequest budget. Mirrors the bookkeeping in
 * `OrgClickHouseSettingsService`/`@maple/clickhouse-cli` (`_maple_schema_migrations`)
 * and writes UI progress to `org_clickhouse_schema_apply_runs`.
 */
import { createDecipheriv } from "node:crypto"
import { orgClickHouseSchemaApplyRuns, orgClickHouseSettings } from "@maple/db"
import { createMaplePgClient, type MaplePgClient } from "@maple/db/client"
import {
	clickHouseSchemaVersion,
	computeSchemaDiff,
	expandMigrationToSteps,
	extractColumnDefinition,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	qualifyStatementForDatabase,
	type ActualTable,
	type DesiredTable,
} from "@maple/domain/clickhouse"
import { eq } from "drizzle-orm"

export interface SchemaApplyWorkflowEnv {
	readonly MAPLE_DB: unknown
	readonly MAPLE_INGEST_KEY_ENCRYPTION_KEY: string
}

export interface SchemaApplyWorkflowPayload {
	readonly orgId: string
}

export interface SchemaApplyWorkflowResult {
	readonly status: "succeeded" | "failed"
	readonly appliedVersions: ReadonlyArray<number>
}

// Minimal structural views of the Cloudflare Workflow primitives so this module
// doesn't statically import `cloudflare:workers` (kept to the shell).
interface StepConfig {
	readonly retries?: { readonly limit: number; readonly delay: string | number; readonly backoff?: string }
}
export interface WorkflowStepLike {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
	do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>
}
export interface WorkflowEventLike<T> {
	readonly payload: T
}

/**
 * Narrow the worker env's `MAPLE_DB` Hyperdrive binding to its connection
 * string. Workflows share the worker env, where `MAPLE_DB` is the Hyperdrive
 * binding the request-path `DatabasePgLive` layer also dials.
 */
const resolveMapleDbConnectionString = (binding: unknown): string => {
	if (
		typeof binding === "object" &&
		binding !== null &&
		typeof (binding as { connectionString?: unknown }).connectionString === "string"
	) {
		return (binding as { connectionString: string }).connectionString
	}
	throw new Error("MAPLE_DB is not a Hyperdrive binding (missing connectionString)")
}

const STEP: StepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }

// --- ClickHouse exec --------------------------------------------------------

interface ChConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

async function exec(cfg: ChConfig, sql: string): Promise<string> {
	const url = `${cfg.url.replace(/\/$/, "")}/?database=${encodeURIComponent(cfg.database)}`
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": cfg.user,
		"X-ClickHouse-Database": cfg.database,
	}
	if (cfg.password.length > 0) headers["X-ClickHouse-Key"] = cfg.password
	const response = await fetch(url, { method: "POST", headers, body: sql, redirect: "manual" })
	const text = await response.text()
	if (response.status >= 300 && response.status < 400) {
		throw new Error(`ClickHouse redirect responses are not allowed (${response.status})`)
	}
	if (!response.ok) {
		throw new Error(`ClickHouse ${response.status}: ${text.split("\n")[0]?.slice(0, 500) ?? ""}`)
	}
	return text
}

const parseJsonEachRow = <T>(text: string): ReadonlyArray<T> => {
	const out: T[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			out.push(JSON.parse(trimmed) as T)
		} catch {
			// controlled query
		}
	}
	return out
}

// --- migration bookkeeping (mirrors the service + CLI) ----------------------

const MIGRATIONS_TABLE = "_maple_schema_migrations"
const quote = (name: string): string => `\`${name.replace(/`/g, "``")}\``

const ensureMigrationsTable = (cfg: ChConfig) =>
	exec(
		cfg,
		`CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (version UInt32, applied_at DateTime64(3) DEFAULT now64(3), description String) ENGINE = MergeTree ORDER BY version`,
	)

const readAppliedVersions = async (cfg: ChConfig): Promise<Set<number>> => {
	const text = await exec(cfg, `SELECT version FROM ${quote(MIGRATIONS_TABLE)} FORMAT JSONEachRow`)
	return new Set(parseJsonEachRow<{ version: number }>(text).map((r) => Number(r.version)))
}

const recordVersion = (cfg: ChConfig, version: number, description: string) =>
	exec(
		cfg,
		`INSERT INTO ${quote(MIGRATIONS_TABLE)} (version, description) VALUES (${version}, '${description.replace(/'/g, "''")}')`,
	)

// --- config load + decrypt (imperative mirror of the service helper) --------

const loadConfig = async (db: MaplePgClient, orgId: string, encryptionKey: Buffer): Promise<ChConfig> => {
	const rows = await db
		.select()
		.from(orgClickHouseSettings)
		.where(eq(orgClickHouseSettings.orgId, orgId))
		.limit(1)
	const row = rows[0]
	if (!row) throw new Error(`No ClickHouse settings configured for org ${orgId}`)
	let password = ""
	if (row.chPasswordCiphertext && row.chPasswordIv && row.chPasswordTag) {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			encryptionKey,
			Buffer.from(row.chPasswordIv, "base64"),
		)
		decipher.setAuthTag(Buffer.from(row.chPasswordTag, "base64"))
		password = Buffer.concat([
			decipher.update(Buffer.from(row.chPasswordCiphertext, "base64")),
			decipher.final(),
		]).toString("utf8")
	}
	let parsedUrl: URL
	try {
		parsedUrl = new URL(row.chUrl)
	} catch {
		throw new Error("Stored ClickHouse URL is invalid")
	}
	if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
		throw new Error("Stored ClickHouse credentials must not be embedded in the URL")
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new Error("Stored ClickHouse URL must use HTTP or HTTPS")
	}
	if (password.length > 0 && parsedUrl.protocol !== "https:") {
		throw new Error("Stored ClickHouse URL must use HTTPS when a password is configured")
	}
	return { url: row.chUrl, user: row.chUser, password, database: row.chDatabase }
}

// --- run-row progress (org_clickhouse_schema_apply_runs) --------------------

type RunPatch = Partial<{
	status: "queued" | "running" | "succeeded" | "failed"
	phase: string | null
	currentMigration: number | null
	stepsTotal: number | null
	stepsDone: number | null
	appliedVersions: ReadonlyArray<number> | null
	skipped: unknown
	errorMessage: string | null
	startedAt: Date | null
	finishedAt: Date | null
}>

const updateRun = async (db: MaplePgClient, orgId: string, patch: RunPatch, now: number): Promise<void> => {
	await db
		.update(orgClickHouseSchemaApplyRuns)
		.set({ ...patch, updatedAt: new Date(now) })
		.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId))
}

// --- snapshot-diff additive (mirror of OrgClickHouseSettingsService) --------

const parseDesiredTables = (): ReadonlyArray<DesiredTable> => {
	const out: DesiredTable[] = []
	for (const stmt of clickHouseMigrations[0]?.statements ?? []) {
		if (typeof stmt !== "string") continue
		const parsed = parseEmittedStatement(stmt)
		if (!parsed) continue
		out.push({
			name: parsed.name,
			kind: parsed.kind,
			columns: parsed.kind === "table" ? parsed.columns : [],
			createStatement: stmt,
		})
	}
	return out
}

const fetchActualSchema = async (cfg: ChConfig): Promise<Map<string, ActualTable>> => {
	const dbLit = cfg.database.replace(/'/g, "''")
	const tableRows = parseJsonEachRow<{ name: string; engine: string }>(
		await exec(
			cfg,
			`SELECT name, engine FROM system.tables WHERE database = '${dbLit}' FORMAT JSONEachRow`,
		),
	)
	const columnRows = parseJsonEachRow<{ table: string; name: string; type: string }>(
		await exec(
			cfg,
			`SELECT table, name, type FROM system.columns WHERE database = '${dbLit}' FORMAT JSONEachRow`,
		),
	)
	const colsByTable = new Map<string, Array<{ name: string; type: string }>>()
	for (const r of columnRows) {
		const list = colsByTable.get(r.table) ?? []
		list.push({ name: r.name, type: r.type })
		colsByTable.set(r.table, list)
	}
	const result = new Map<string, ActualTable>()
	for (const t of tableRows) {
		result.set(t.name, {
			name: t.name,
			kind: t.engine === "MaterializedView" ? "materialized_view" : "table",
			columns: colsByTable.get(t.name) ?? [],
		})
	}
	return result
}

// --- orchestration ----------------------------------------------------------

export async function runClickHouseSchemaApply(
	env: SchemaApplyWorkflowEnv,
	event: WorkflowEventLike<SchemaApplyWorkflowPayload>,
	step: WorkflowStepLike,
): Promise<SchemaApplyWorkflowResult> {
	const connection = createMaplePgClient(resolveMapleDbConnectionString(env.MAPLE_DB), {
		maxConnections: 1,
	})
	try {
		return await runWithDb(connection.db, env, event, step)
	} finally {
		await connection.end().catch(() => undefined)
	}
}

async function runWithDb(
	db: MaplePgClient,
	env: SchemaApplyWorkflowEnv,
	event: WorkflowEventLike<SchemaApplyWorkflowPayload>,
	step: WorkflowStepLike,
): Promise<SchemaApplyWorkflowResult> {
	const orgId = event.payload.orgId
	const encryptionKey = Buffer.from(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY.trim(), "base64")
	const startedAt = Date.now()
	const appliedVersions: number[] = []

	const cfg = await step.do("load-config", STEP, async () => {
		const c = await loadConfig(db, orgId, encryptionKey)
		await updateRun(
			db,
			orgId,
			{ status: "running", phase: "connecting", errorMessage: null, startedAt: new Date(startedAt) },
			Date.now(),
		)
		return c
	})

	try {
		await step.do("ensure-bookkeeping", STEP, () => ensureMigrationsTable(cfg).then(() => undefined))
		const applied = await step.do("read-applied", STEP, () =>
			readAppliedVersions(cfg).then((s) => [...s]),
		)
		const appliedSet = new Set(applied)

		for (const migration of clickHouseMigrations) {
			if (appliedSet.has(migration.version)) continue

			const steps = await step.do(`plan-m${migration.version}`, STEP, () =>
				expandMigrationToSteps(migration, cfg.database, (sql) => exec(cfg, sql)).then((s) => [...s]),
			)
			const total = steps.length
			let done = 0
			for (const s of steps) {
				await step.do(`m${migration.version}:${s.name}`, STEP, async () => {
					await exec(cfg, s.sql)
				})
				done += 1
				await updateRun(
					db,
					orgId,
					{
						phase: `migration ${migration.version} · ${s.name}`,
						currentMigration: migration.version,
						stepsTotal: total,
						stepsDone: done,
					},
					Date.now(),
				)
			}
			await step.do(`record-m${migration.version}`, STEP, () =>
				recordVersion(cfg, migration.version, migration.description).then(() => undefined),
			)
			appliedVersions.push(migration.version)
		}

		// Snapshot-diff additive pass: create snapshot objects missing on the
		// cluster + add missing columns (metadata-only, fits a step easily).
		await step.do("snapshot-diff", STEP, async () => {
			await updateRun(db, orgId, { phase: "reconciling schema snapshot" }, Date.now())
			const desired = parseDesiredTables()
			const desiredByName = new Map(desired.map((t) => [t.name, t]))
			const actual = await fetchActualSchema(cfg)
			for (const entry of computeSchemaDiff({ tables: desired }, actual)) {
				if (entry.status === "missing") {
					const table = desiredByName.get(entry.name)
					if (table)
						await exec(cfg, qualifyStatementForDatabase(table.createStatement, cfg.database))
				} else if (entry.status === "drifted" && entry.kind === "table") {
					const table = desiredByName.get(entry.name)
					if (!table) continue
					for (const drift of entry.columnDrifts.filter((d) => d.kind === "missing")) {
						const colDef = extractColumnDefinition(table.createStatement, drift.column)
						if (colDef) {
							await exec(
								cfg,
								`ALTER TABLE ${quote(cfg.database)}.${quote(entry.name)} ADD COLUMN IF NOT EXISTS ${colDef}`,
							)
						}
					}
				}
			}
		})

		const finishedAt = Date.now()
		await step.do("finalize", STEP, async () => {
			await db
				.update(orgClickHouseSettings)
				.set({
					lastSyncAt: new Date(finishedAt),
					lastSyncError: null,
					syncStatus: "connected",
					schemaVersion: clickHouseSchemaVersion,
					updatedAt: new Date(finishedAt),
				})
				.where(eq(orgClickHouseSettings.orgId, orgId))
			await updateRun(
				db,
				orgId,
				{
					status: "succeeded",
					phase: "done",
					currentMigration: null,
					appliedVersions,
					finishedAt: new Date(finishedAt),
				},
				finishedAt,
			)
		})

		return { status: "succeeded", appliedVersions }
	} catch (error) {
		const finishedAt = Date.now()
		const message = error instanceof Error ? error.message : String(error)
		await updateRun(
			db,
			orgId,
			{ status: "failed", errorMessage: message, finishedAt: new Date(finishedAt) },
			finishedAt,
		).catch(() => undefined)
		await db
			.update(orgClickHouseSettings)
			.set({ syncStatus: "error", lastSyncError: message, updatedAt: new Date(finishedAt) })
			.where(eq(orgClickHouseSettings.orgId, orgId))
			.catch(() => undefined)
		throw error
	}
}
