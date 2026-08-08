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
import type { MaplePgClient } from "@maple/db/client"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import {
	clickHouseSchemaVersion,
	clickHouseSchemaFeatures,
	computeSchemaDiff,
	expandMigrationToSteps,
	extractColumnDefinition,
	featureSupportedByVersion,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	performanceOnlySearchColumns,
	qualifyStatementForDatabase,
	type ActualTable,
	type DesiredTable,
} from "@maple/domain/clickhouse"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { makeTracedPgConnection, type TracedPgConnection } from "@/platform/pg-execute"

/**
 * This workflow runs outside the worker's layer graph, so it owns its telemetry
 * instance and drains it itself.
 * Module scope is safe because the file is only ever dynamically imported from
 * the thin shell in `ClickHouseSchemaApplyWorkflow.ts`, off the startup-CPU path.
 */
const schemaApplyTelemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

/** One unit of DB work, traced as a `Database.execute` client span. */
type DbStep = <T>(fn: (db: MaplePgClient) => Promise<T>) => Promise<T>

export interface SchemaApplyWorkflowEnv extends Record<string, unknown> {
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

interface LoadOptionalFeatureStateOptions {
	readonly ensureBookkeeping: () => Promise<void>
	readonly readServerVersion: () => Promise<string>
	readonly readAppliedFeatureRevisions: () => Promise<ReadonlyMap<string, number>>
}

export type OptionalFeatureState =
	| {
			readonly available: true
			readonly serverVersion: string
			readonly appliedFeatureRevisions: ReadonlyMap<string, number>
	  }
	| { readonly available: false; readonly reason: string }

/**
 * Optional feature metadata must never decide whether the correctness schema
 * is ready for ingest. Keeping this boundary explicit also makes the workflow
 * policy testable without a live durable-workflow runtime.
 */
export async function loadOptionalFeatureState(
	options: LoadOptionalFeatureStateOptions,
): Promise<OptionalFeatureState> {
	try {
		await options.ensureBookkeeping()
		const serverVersion = await options.readServerVersion()
		const appliedFeatureRevisions = await options.readAppliedFeatureRevisions()
		return { available: true, serverVersion, appliedFeatureRevisions }
	} catch (error) {
		return {
			available: false,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
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
const FEATURES_TABLE = "_maple_schema_features"
const quote = (name: string): string => `\`${name.replace(/`/g, "``")}\``

const ensureMigrationsTable = (cfg: ChConfig) =>
	exec(
		cfg,
		`CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (version UInt32, applied_at DateTime64(3) DEFAULT now64(3), description String) ENGINE = MergeTree ORDER BY version`,
	)

const ensureFeaturesTable = (cfg: ChConfig) =>
	exec(
		cfg,
		`CREATE TABLE IF NOT EXISTS ${quote(FEATURES_TABLE)} (
  id String,
  revision UInt32,
  applied_at DateTime64(3) DEFAULT now64(3),
  description String
) ENGINE = ReplacingMergeTree(revision) ORDER BY id`,
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

const readAppliedFeatureRevisions = async (cfg: ChConfig): Promise<Map<string, number>> => {
	const text = await exec(
		cfg,
		`SELECT id, max(revision) AS revision FROM ${quote(FEATURES_TABLE)} GROUP BY id FORMAT JSONEachRow`,
	)
	return new Map(
		parseJsonEachRow<{ id: string; revision: string | number }>(text).map((row) => [
			row.id,
			Number(row.revision),
		]),
	)
}

const recordFeature = (cfg: ChConfig, id: string, revision: number, description: string) =>
	exec(
		cfg,
		`INSERT INTO ${quote(FEATURES_TABLE)} (id, revision, description) VALUES ('${id.replace(/'/g, "''")}', ${revision}, '${description.replace(/'/g, "''")}')`,
	)

const normalizeExpression = (value: string): string =>
	value.replace(/`/g, "").replace(/\s+/g, "").toLowerCase()

// --- config load + decrypt (imperative mirror of the service helper) --------

const loadConfig = async (dbStep: DbStep, orgId: string, encryptionKey: Buffer): Promise<ChConfig> => {
	const rows = await dbStep((db) =>
		db.select().from(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId)).limit(1),
	)
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

const updateRun = async (dbStep: DbStep, orgId: string, patch: RunPatch, now: number): Promise<void> => {
	await dbStep((db) =>
		db
			.update(orgClickHouseSchemaApplyRuns)
			.set({ ...patch, updatedAt: new Date(now) })
			.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId)),
	)
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
			columns:
				parsed.kind === "table"
					? parsed.columns.filter(
							(column) => !performanceOnlySearchColumns.has(`${parsed.name}.${column.name}`),
						)
					: [],
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
	const connection = makeTracedPgConnection(resolveMapleDbConnectionString(env.MAPLE_DB))
	try {
		return await runWithDb(connection, env, event, step)
	} finally {
		await connection.end()
		// This module owns its telemetry instance (the workflow runs outside the
		// worker's layer graph), so nothing else will drain the span buffer.
		await schemaApplyTelemetry.flush(env).catch(() => undefined)
	}
}

async function runWithDb(
	connection: TracedPgConnection,
	env: SchemaApplyWorkflowEnv,
	event: WorkflowEventLike<SchemaApplyWorkflowPayload>,
	step: WorkflowStepLike,
): Promise<SchemaApplyWorkflowResult> {
	const orgId = event.payload.orgId
	const dbStep: DbStep = (fn) =>
		Effect.runPromise(connection.step(fn).pipe(Effect.provide(schemaApplyTelemetry.layer)))
	const encryptionKey = Buffer.from(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY.trim(), "base64")
	const startedAt = Date.now()
	const appliedVersions: number[] = []
	const skippedFeatures: Array<{ readonly id: string; readonly reason: string }> = []

	const cfg = await step.do("load-config", STEP, async () => {
		const c = await loadConfig(dbStep, orgId, encryptionKey)
		await updateRun(
			dbStep,
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
			if (migration.requiredForIngest === false) continue
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
					dbStep,
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
			await updateRun(dbStep, orgId, { phase: "reconciling schema snapshot" }, Date.now())
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

		// Correctness is complete before optional performance work begins. This
		// keeps direct ingest ready even when a version-gated index cannot be
		// installed due to permissions, server support, or transient load.
		await step.do("stamp-correctness", STEP, async () => {
			const stampedAt = Date.now()
			await dbStep((db) =>
				db
					.update(orgClickHouseSettings)
					.set({
						lastSyncAt: new Date(stampedAt),
						lastSyncError: null,
						syncStatus: "connected",
						schemaVersion: clickHouseSchemaVersion,
						updatedAt: new Date(stampedAt),
					})
					.where(eq(orgClickHouseSettings.orgId, orgId)),
			)
		})

		for (const migration of clickHouseMigrations) {
			if (migration.requiredForIngest !== false || appliedSet.has(migration.version)) continue
			try {
				const steps = await step.do(`plan-performance-m${migration.version}`, STEP, () =>
					expandMigrationToSteps(migration, cfg.database, (sql) => exec(cfg, sql)).then((s) => [
						...s,
					]),
				)
				for (const [index, migrationStep] of steps.entries()) {
					await step.do(
						`performance-m${migration.version}:${migrationStep.name}`,
						STEP,
						async () => {
							await updateRun(
								dbStep,
								orgId,
								{
									phase: `performance migration ${migration.version} · ${index + 1}/${steps.length}`,
									currentMigration: migration.version,
									stepsTotal: steps.length,
									stepsDone: index,
								},
								Date.now(),
							)
							await exec(cfg, migrationStep.sql)
						},
					)
				}
				await step.do(`record-performance-m${migration.version}`, STEP, () =>
					recordVersion(cfg, migration.version, migration.description).then(() => undefined),
				)
				appliedSet.add(migration.version)
				appliedVersions.push(migration.version)
			} catch (error) {
				skippedFeatures.push({
					id: `migration_${migration.version}`,
					reason: error instanceof Error ? error.message : String(error),
				})
			}
		}

		const optionalFeatureState = await loadOptionalFeatureState({
			ensureBookkeeping: () =>
				step.do("ensure-feature-bookkeeping", STEP, () =>
					ensureFeaturesTable(cfg).then(() => undefined),
				),
			readServerVersion: () =>
				step.do("read-clickhouse-version", STEP, () =>
					exec(cfg, "SELECT version() FORMAT TabSeparated").then((value) => value.trim()),
				),
			readAppliedFeatureRevisions: () =>
				step
					.do("read-applied-features", STEP, () =>
						readAppliedFeatureRevisions(cfg).then((entries) => [...entries]),
					)
					.then((entries) => new Map(entries)),
		})
		if (!optionalFeatureState.available) {
			skippedFeatures.push({
				id: "feature_reconciliation",
				reason: optionalFeatureState.reason,
			})
		}
		if (optionalFeatureState.available) {
			const { serverVersion, appliedFeatureRevisions } = optionalFeatureState
			for (const feature of clickHouseSchemaFeatures) {
				if (!featureSupportedByVersion(feature, serverVersion)) {
					skippedFeatures.push({
						id: feature.id,
						reason: `requires ClickHouse ${feature.minClickHouseVersion}+`,
					})
					continue
				}
				if ((appliedFeatureRevisions.get(feature.id) ?? 0) >= feature.revision) continue

				try {
					let satisfied = false
					const sortingKeyRequirement = feature.satisfiedBySortingKey
					if (sortingKeyRequirement) {
						satisfied = await step.do(`feature-${feature.id}:inspect`, STEP, async () => {
							const table = sortingKeyRequirement.table.replace(/'/g, "''")
							const result = await exec(
								cfg,
								`SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = '${table}' FORMAT JSONEachRow`,
							)
							const row = parseJsonEachRow<{ sorting_key?: string }>(result)[0]
							return (
								normalizeExpression(row?.sorting_key ?? "") ===
								normalizeExpression(sortingKeyRequirement.expected)
							)
						})
					}

					if (!satisfied) {
						for (let index = 0; index < feature.statements.length; index++) {
							const statement = feature.statements[index]!
							await step.do(`feature-${feature.id}:${index + 1}`, STEP, async () => {
								await updateRun(
									dbStep,
									orgId,
									{
										phase: `feature ${feature.id} · ${index + 1}/${feature.statements.length}`,
									},
									Date.now(),
								)
								await exec(cfg, statement)
							})
						}
					}
					await step.do(`feature-${feature.id}:record`, STEP, () =>
						recordFeature(cfg, feature.id, feature.revision, feature.description).then(
							() => undefined,
						),
					)
				} catch (error) {
					skippedFeatures.push({
						id: feature.id,
						reason: error instanceof Error ? error.message : String(error),
					})
				}
			}
		}

		const finishedAt = Date.now()
		await step.do("finalize", STEP, async () => {
			await updateRun(
				dbStep,
				orgId,
				{
					status: "succeeded",
					phase: "done",
					currentMigration: null,
					appliedVersions,
					skipped: skippedFeatures,
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
			dbStep,
			orgId,
			{ status: "failed", errorMessage: message, finishedAt: new Date(finishedAt) },
			finishedAt,
		).catch(() => undefined)
		await dbStep((db) =>
			db
				.update(orgClickHouseSettings)
				.set({ syncStatus: "error", lastSyncError: message, updatedAt: new Date(finishedAt) })
				.where(eq(orgClickHouseSettings.orgId, orgId)),
		).catch(() => undefined)
		throw error
	}
}
