import {
	IsoDateTimeString,
	OrgClickHouseApplySchemaResult,
	OrgClickHouseCollectorConfigResponse,
	OrgClickHouseSchemaDiffResponse,
	OrgClickHouseSettingsDeleteResponse,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsForbiddenError,
	OrgClickHouseSettingsPersistenceError,
	OrgClickHouseSettingsResponse,
	OrgClickHouseSettingsUpstreamRejectedError,
	OrgClickHouseSettingsUpstreamUnavailableError,
	OrgClickHouseSettingsValidationError,
	type OrgClickHouseSettingsUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import {
	CLICKHOUSE_MV_SOURCE_TABLES,
	clickHouseProjectRevision,
	computeSchemaDiff,
	extractColumnDefinition,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	qualifyStatementForDatabase,
	type ActualTable,
	type DesiredTable,
} from "@maple/domain/clickhouse"
import { orgClickHouseSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Redacted, Schema, Context } from "effect"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"
import { validateExternalUrl } from "../lib/url-validator"

/**
 * Resolved per-org backend config, returned to the runtime SQL layer.
 *
 * Only ClickHouse is supported for BYO now — the BYO-Tinybird path was
 * retired. Default Maple-managed Tinybird Cloud rows have no persisted
 * settings row, so callers will see `Option.none()` from
 * `resolveRuntimeConfig` for those orgs.
 */
export type RuntimeBackendConfig = {
	readonly backend: "clickhouse"
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

type ActiveRow = typeof orgClickHouseSettings.$inferSelect

const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

export interface OrgClickHouseSettingsServiceShape {
	readonly get: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsDeleteResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly schemaDiff: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSchemaDiffResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly applySchema: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseApplySchemaResult,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly resolveRuntimeConfig: (
		orgId: OrgId,
	) => Effect.Effect<
		Option.Option<RuntimeBackendConfig>,
		OrgClickHouseSettingsPersistenceError | OrgClickHouseSettingsEncryptionError
	>
	readonly collectorConfig: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseCollectorConfigResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
	>
}

const toPersistenceError = (error: unknown) =>
	new OrgClickHouseSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Org ClickHouse settings persistence failed",
	})

const toEncryptionError = (message: string) => new OrgClickHouseSettingsEncryptionError({ message })

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, OrgClickHouseSettingsEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptToken = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, OrgClickHouseSettingsEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () => toEncryptionError("Failed to encrypt ClickHouse password"))

const decryptToken = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () => toEncryptionError("Failed to decrypt ClickHouse password"))

// Both `qualifyStatementForDatabase` and `CLICKHOUSE_MV_SOURCE_TABLES` live
// in `@maple/domain/clickhouse` now (so the `@maple/clickhouse-cli` package
// can share them) and are imported at the top of this file. Re-exported here
// for any tests / callers that still import from this module path.
export { CLICKHOUSE_MV_SOURCE_TABLES, qualifyStatementForDatabase }

// Image reference baked into the rendered collector config. Bumping this
// here is the single edit needed to roll customers onto a newer maple-otel
// collector — the generated YAML and the documented `docker run …` command
// both pick it up.
const COLLECTOR_IMAGE_REF = "ghcr.io/makisuo/maple/otel-collector-maple:0.1.5"
const COLLECTOR_PASSWORD_ENV = "MAPLE_CLICKHOUSE_PASSWORD"

/**
 * Render a ready-to-run OpenTelemetry Collector YAML for an org's BYO
 * ClickHouse. Returned by the `collectorConfig` endpoint.
 *
 * The org's CH URL/user/database are interpolated. The password is left as
 * a `${env:MAPLE_CLICKHOUSE_PASSWORD}` reference so the rendered file is
 * safe to share over chat / email / version control.
 *
 * Pipeline shape: OTLP receivers → memory_limiter → k8sattributes (best-
 * effort, ignored if RBAC is missing) → batch → maple exporter. Same
 * shape as the maple-otel Helm chart so non-Kubernetes customers get
 * parity with K8s ones.
 */
const renderCollectorYaml = (input: {
	readonly orgId: string
	readonly endpoint: string
	readonly user: string
	readonly database: string
}): string => {
	// Hand-crafted YAML rather than a templating engine so a customer
	// reading this file sees something stable and diffable.
	const lines = [
		"# Generated by Maple — your per-org OpenTelemetry Collector config.",
		"# Run with: docker run -e " +
			COLLECTOR_PASSWORD_ENV +
			"=$PASS -v ./collector.yaml:/etc/otel/config.yaml -p 4317:4317 -p 4318:4318 " +
			COLLECTOR_IMAGE_REF,
		"",
		"extensions:",
		"  health_check:",
		"    endpoint: 0.0.0.0:13133",
		"",
		"receivers:",
		"  otlp:",
		"    protocols:",
		"      grpc:",
		"        endpoint: 0.0.0.0:4317",
		"      http:",
		"        endpoint: 0.0.0.0:4318",
		"",
		"processors:",
		"  memory_limiter:",
		"    check_interval: 1s",
		"    limit_mib: 3000",
		"    spike_limit_mib: 500",
		"  k8sattributes:",
		"    passthrough: false",
		"    pod_association:",
		"      - sources:",
		"          - from: resource_attribute",
		"            name: k8s.pod.uid",
		"      - sources:",
		"          - from: connection",
		"    extract:",
		"      metadata:",
		"        - k8s.namespace.name",
		"        - k8s.deployment.name",
		"        - k8s.statefulset.name",
		"        - k8s.daemonset.name",
		"        - k8s.cronjob.name",
		"        - k8s.job.name",
		"        - k8s.node.name",
		"        - k8s.pod.name",
		"        - k8s.pod.uid",
		"        - k8s.pod.start_time",
		"  batch:",
		"    send_batch_size: 2000",
		"    timeout: 10s",
		"",
		"exporters:",
		"  maple:",
		`    endpoint: ${quoteYaml(input.endpoint)}`,
		`    database: ${quoteYaml(input.database)}`,
		`    username: ${quoteYaml(input.user)}`,
		`    password: "$\{env:${COLLECTOR_PASSWORD_ENV}}"`,
		`    org_id: ${quoteYaml(input.orgId)}`,
		"    timeout: 30s",
		"    retry_on_failure:",
		"      enabled: true",
		"      initial_interval: 1s",
		"      max_interval: 30s",
		"      max_elapsed_time: 300s",
		"    sending_queue:",
		"      enabled: true",
		"      num_consumers: 8",
		"      queue_size: 10000",
		"",
		"service:",
		"  extensions: [health_check]",
		"  pipelines:",
		"    traces:",
		"      receivers: [otlp]",
		// k8sattributes is harmless when RBAC isn't present (it just no-ops),
		// so leave it in the pipeline by default — customers running on K8s
		// get free enrichment, customers on Docker/bare-metal pay nothing.
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    logs:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    metrics:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"  telemetry:",
		"    logs:",
		"      level: info",
	]
	return lines.join("\n") + "\n"
}

/**
 * Quote a YAML scalar so any `:` / `#` / leading-whitespace doesn't break
 * the serialiser. We always wrap in double quotes for predictability.
 */
const quoteYaml = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const normalizeHttpUrl = (raw: string): Effect.Effect<string, OrgClickHouseSettingsValidationError> =>
	validateExternalUrl(raw).pipe(
		Effect.map(() => raw.trim().replace(/\/+$/, "")),
		Effect.mapError(
			(error) =>
				new OrgClickHouseSettingsValidationError({
					message: error.message,
				}),
		),
	)

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const isIsoDateTime = (value: number | null | undefined) =>
	value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

const decodeStatus = (raw: string | null | undefined): "connected" | "error" | null => {
	if (raw === "connected" || raw === "error") return raw
	return null
}

// --- Desired-schema cache ----------------------------------------------------
//
// We parse the bundled snapshot statements once on first use and reuse the
// result. Parsing is cheap, but the snapshot is also static across the
// process lifetime so re-parsing on every request would be wasted work.

let cachedDesiredTables: ReadonlyArray<DesiredTable> | null = null

const getDesiredTables = (): ReadonlyArray<DesiredTable> => {
	if (cachedDesiredTables) return cachedDesiredTables
	const out: DesiredTable[] = []
	for (const stmt of clickHouseMigrations[0]?.statements ?? []) {
		const parsed = parseEmittedStatement(stmt)
		if (!parsed) continue
		out.push({
			name: parsed.name,
			kind: parsed.kind,
			columns: parsed.kind === "table" ? parsed.columns : [],
			createStatement: stmt,
		})
	}
	cachedDesiredTables = out
	return out
}

// --- ClickHouse HTTP exec helpers --------------------------------------------

interface ClickHouseExecConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

const buildClickHouseHeaders = (config: ClickHouseExecConfig): Record<string, string> => {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": config.user,
		"X-ClickHouse-Database": config.database,
	}
	if (config.password.length > 0) {
		headers["X-ClickHouse-Key"] = config.password
	}
	return headers
}

const buildClickHouseUrl = (config: ClickHouseExecConfig): string =>
	// Send the database as a URL parameter as well: ClickHouse Cloud's new
	// analyzer (24.x+) sometimes fails to resolve unqualified table identifiers
	// in materialized view bodies even when the X-ClickHouse-Database header is
	// set, surfacing as `Code: 60. UNKNOWN_TABLE`.
	`${config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(config.database)}`

const execClickHouse = (config: ClickHouseExecConfig, sql: string) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(buildClickHouseUrl(config), {
				method: "POST",
				headers: buildClickHouseHeaders(config),
				body: sql,
			})
			const text = await response.text()
			if (!response.ok) {
				const status = response.status
				const message = text.split("\n")[0]?.slice(0, 500) ?? ""
				if (status === 401 || status === 403) {
					throw new OrgClickHouseSettingsUpstreamRejectedError({
						message: `ClickHouse rejected credentials: ${message}`,
						statusCode: status,
					})
				}
				if (status >= 500) {
					throw new OrgClickHouseSettingsUpstreamUnavailableError({
						message: `ClickHouse upstream error (${status}): ${message}`,
						statusCode: status,
					})
				}
				throw new OrgClickHouseSettingsUpstreamRejectedError({
					message: `ClickHouse rejected statement (${status}): ${message}`,
					statusCode: status,
				})
			}
			return text
		},
		catch: (error) => {
			if (
				error instanceof OrgClickHouseSettingsUpstreamRejectedError ||
				error instanceof OrgClickHouseSettingsUpstreamUnavailableError
			) {
				return error
			}
			return new OrgClickHouseSettingsUpstreamUnavailableError({
				message: `Could not reach ClickHouse: ${error instanceof Error ? error.message : String(error)}`,
				statusCode: null,
			})
		},
	})

interface ClickHouseTableRow {
	readonly name: string
	readonly engine: string
}
interface ClickHouseColumnRow {
	readonly table: string
	readonly name: string
	readonly type: string
}

const fetchActualSchema = (config: ClickHouseExecConfig) =>
	Effect.gen(function* () {
		// Tables: name + engine. Engine="MaterializedView" → MV; everything else → table.
		const tablesSql = `SELECT name, engine FROM system.tables WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const tablesText = yield* execClickHouse(config, tablesSql)
		const tableRows = parseJsonEachRow<ClickHouseTableRow>(tablesText)

		const columnsSql = `SELECT table, name, type FROM system.columns WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const columnsText = yield* execClickHouse(config, columnsSql)
		const columnRows = parseJsonEachRow<ClickHouseColumnRow>(columnsText)

		const colsByTable = new Map<string, Array<{ name: string; type: string }>>()
		for (const row of columnRows) {
			const list = colsByTable.get(row.table) ?? []
			list.push({ name: row.name, type: row.type })
			colsByTable.set(row.table, list)
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
	})

const parseJsonEachRow = <T>(text: string): ReadonlyArray<T> => {
	const out: T[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			out.push(JSON.parse(trimmed) as T)
		} catch {
			// Skip malformed rows — the entire response is from us-controlled
			// queries against system.* tables, so this is defence-in-depth.
		}
	}
	return out
}

// --- Service -----------------------------------------------------------------

export class OrgClickHouseSettingsService extends Context.Service<
	OrgClickHouseSettingsService,
	OrgClickHouseSettingsServiceShape
>()("OrgClickHouseSettingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))

		const requireAdmin = Effect.fn("OrgClickHouseSettingsService.requireAdmin")(function* (
			roles: ReadonlyArray<RoleName>,
		) {
			if (isOrgAdmin(roles)) return
			return yield* Effect.fail(
				new OrgClickHouseSettingsForbiddenError({
					message: "Only org admins can manage ClickHouse settings",
				}),
			)
		})

		const selectActiveRow = Effect.fn("OrgClickHouseSettingsService.selectActiveRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSettings)
						.where(eq(orgClickHouseSettings.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return Option.fromNullishOr(rows[0])
		})

		const requireActiveRow = Effect.fn("OrgClickHouseSettingsService.requireActiveRow")(function* (
			orgId: OrgId,
		) {
			const row = yield* selectActiveRow(orgId)
			if (Option.isSome(row)) return row.value
			return yield* Effect.fail(
				new OrgClickHouseSettingsValidationError({
					message: "BYO ClickHouse is not configured for this org",
				}),
			)
		})

		const decryptStoredPassword = (
			row: ActiveRow,
		): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
			row.chPasswordCiphertext !== null && row.chPasswordIv !== null && row.chPasswordTag !== null
				? decryptToken(
						{
							ciphertext: row.chPasswordCiphertext,
							iv: row.chPasswordIv,
							tag: row.chPasswordTag,
						},
						encryptionKey,
					)
				: Effect.succeed("")

		const toResponse = (
			row: ActiveRow | null | undefined,
		): OrgClickHouseSettingsResponse =>
			new OrgClickHouseSettingsResponse({
				configured: row != null,
				chUrl: row?.chUrl ?? null,
				chUser: row?.chUser ?? null,
				chDatabase: row?.chDatabase ?? null,
				syncStatus: decodeStatus(row?.syncStatus),
				lastSyncAt: isIsoDateTime(row?.lastSyncAt ?? null),
				lastSyncError: row?.lastSyncError ?? null,
				schemaVersion: row?.schemaVersion ?? null,
			})

		const get = Effect.fn("OrgClickHouseSettingsService.get")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(row))
		})

		const upsert = Effect.fn("OrgClickHouseSettingsService.upsert")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			payload: OrgClickHouseSettingsUpsertRequest,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)
			yield* requireAdmin(roles)

			const url = yield* normalizeHttpUrl(payload.url)
			const user = payload.user.trim()
			const dbName = payload.database.trim()
			if (user.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse user is required",
				})
			}
			if (dbName.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse database is required",
				})
			}

			// If the user left the password blank on a re-save, reuse the existing
			// stored password (decrypted from the previous row) ONLY when the URL,
			// user, and database are unchanged. Otherwise we'd be silently sending
			// the stored credential to a different host — an SSRF / credential
			// disclosure path. Force the user to re-enter the password when any
			// connection identifier changes.
			const existingRow = yield* selectActiveRow(orgId)
			let plainPassword = (payload.password ?? "").trim()
			if (plainPassword.length === 0 && Option.isSome(existingRow)) {
				const existing = existingRow.value
				const sameEndpoint =
					existing.chUrl === url &&
					existing.chUser === user &&
					existing.chDatabase === dbName
				if (!sameEndpoint) {
					return yield* new OrgClickHouseSettingsValidationError({
						message:
							"Password is required when changing the ClickHouse URL, user, or database",
					})
				}
				plainPassword = yield* decryptStoredPassword(existing)
			}

			// Connect-and-validate: hit the cluster with `SELECT 1` so a typo'd
			// host or token surfaces here rather than after the user closes the
			// dialog. No DDL is run — applying the schema is a separate explicit
			// action via the diff/apply endpoints.
			yield* execClickHouse(
				{ url, user, password: plainPassword, database: dbName },
				"SELECT 1",
			)

			const encryptedPassword =
				plainPassword.length > 0 ? yield* encryptToken(plainPassword, encryptionKey) : null

			const now = Date.now()
			yield* database
				.execute((db) =>
					db
						.insert(orgClickHouseSettings)
						.values({
							orgId,
							chUrl: url,
							chUser: user,
							chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
							chPasswordIv: encryptedPassword?.iv ?? null,
							chPasswordTag: encryptedPassword?.tag ?? null,
							chDatabase: dbName,
							syncStatus: "connected",
							lastSyncAt: now,
							lastSyncError: null,
							// schemaVersion is preserved across re-saves — credentials
							// changing doesn't invalidate the schema apply state.
							schemaVersion: Option.isSome(existingRow)
								? existingRow.value.schemaVersion
								: null,
							createdAt: Option.isSome(existingRow) ? existingRow.value.createdAt : now,
							updatedAt: now,
							createdBy: Option.isSome(existingRow) ? existingRow.value.createdBy : userId,
							updatedBy: userId,
						})
						.onConflictDoUpdate({
							target: orgClickHouseSettings.orgId,
							set: {
								chUrl: url,
								chUser: user,
								chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
								chPasswordIv: encryptedPassword?.iv ?? null,
								chPasswordTag: encryptedPassword?.tag ?? null,
								chDatabase: dbName,
								syncStatus: "connected",
								lastSyncAt: now,
								lastSyncError: null,
								updatedAt: now,
								updatedBy: userId,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const refreshed = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(refreshed))
		})

		const deleteSettings = Effect.fn("OrgClickHouseSettingsService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			yield* database
				.execute((db) =>
					db.delete(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return new OrgClickHouseSettingsDeleteResponse({ configured: false })
		})

		const loadConfigForRow = (row: ActiveRow) =>
			Effect.map(decryptStoredPassword(row), (password) => ({
				url: row.chUrl,
				user: row.chUser,
				password,
				database: row.chDatabase,
			}))

		const schemaDiff = Effect.fn("OrgClickHouseSettingsService.schemaDiff")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const config = yield* loadConfigForRow(row)
			const actual = yield* fetchActualSchema(config)
			const entries = computeSchemaDiff({ tables: getDesiredTables() }, actual)
			return new OrgClickHouseSchemaDiffResponse({
				expectedSchemaVersion: clickHouseProjectRevision,
				appliedSchemaVersion: row.schemaVersion ?? null,
				entries,
			})
		})

		const applySchema = Effect.fn("OrgClickHouseSettingsService.applySchema")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const config = yield* loadConfigForRow(row)
			const desired = getDesiredTables()
			const desiredByName = new Map(desired.map((t) => [t.name, t]))
			const actual = yield* fetchActualSchema(config)
			const entries = computeSchemaDiff({ tables: desired }, actual)

			const applied: string[] = []
			const skipped: Array<{ name: string; reason: string }> = []

			// Track tables whose drift was *fully* resolved by additive ALTERs, so
			// the schemaVersion bump below stays accurate.
			const fullyResolvedDrift = new Set<string>()

			for (const entry of entries) {
				if (entry.status === "missing") {
					const table = desiredByName.get(entry.name)
					if (!table) continue
					const stmt = qualifyStatementForDatabase(table.createStatement, config.database)
					yield* execClickHouse(config, stmt)
					applied.push(entry.name)
				} else if (entry.status === "drifted") {
					// MV bodies aren't fully diffed (presence-only), so a "drifted" entry
					// always implies kind === "table" today. Defensive guard anyway —
					// dropping/recreating MVs is destructive and out of scope here.
					if (entry.kind !== "table") {
						skipped.push({
							name: entry.name,
							reason: `materialized view drift — resolve manually`,
						})
						continue
					}
					const table = desiredByName.get(entry.name)
					if (!table) {
						skipped.push({ name: entry.name, reason: `desired definition missing` })
						continue
					}

					const missingDrifts = entry.columnDrifts.filter((d) => d.kind === "missing")
					const typeMismatches = entry.columnDrifts.filter((d) => d.kind === "type_mismatch")
					// `extra` drifts (columns the customer has that Maple doesn't expect)
					// don't block — Maple only reads the columns it owns. Surfaced for
					// visibility in the diff response, but ignored here.

					const addedColumns: string[] = []
					const unresolvableAdds: string[] = []
					for (const drift of missingDrifts) {
						const colDef = extractColumnDefinition(table.createStatement, drift.column)
						if (!colDef) {
							// Shouldn't happen — `missing` drift means the column is in the
							// desired schema by definition — but guard against parser drift.
							unresolvableAdds.push(drift.column)
							continue
						}
						const alter = `ALTER TABLE \`${config.database}\`.\`${entry.name}\` ADD COLUMN IF NOT EXISTS ${colDef}`
						yield* execClickHouse(config, alter)
						addedColumns.push(drift.column)
					}

					const remainingIssues =
						typeMismatches.length + unresolvableAdds.length
					if (remainingIssues === 0) {
						applied.push(entry.name)
						fullyResolvedDrift.add(entry.name)
					} else {
						const parts: string[] = []
						if (addedColumns.length > 0) {
							parts.push(
								`${addedColumns.length} column${addedColumns.length === 1 ? "" : "s"} added`,
							)
						}
						if (typeMismatches.length > 0) {
							parts.push(
								`${typeMismatches.length} type mismatch${typeMismatches.length === 1 ? "" : "es"} — resolve manually`,
							)
						}
						if (unresolvableAdds.length > 0) {
							parts.push(
								`${unresolvableAdds.length} column${unresolvableAdds.length === 1 ? "" : "s"} unparseable`,
							)
						}
						skipped.push({ name: entry.name, reason: parts.join("; ") })
					}
				}
				// `up_to_date` entries are silently passed over.
			}

			const now = Date.now()
			const allSatisfied = entries.every(
				(e) =>
					e.status === "up_to_date" ||
					(e.status === "missing" && applied.includes(e.name)) ||
					(e.status === "drifted" && fullyResolvedDrift.has(e.name)),
			)
			yield* database
				.execute((db) =>
					db
						.update(orgClickHouseSettings)
						.set({
							lastSyncAt: now,
							lastSyncError: null,
							syncStatus: "connected",
							schemaVersion: allSatisfied ? clickHouseProjectRevision : row.schemaVersion,
							updatedAt: now,
							updatedBy: userId,
						})
						.where(eq(orgClickHouseSettings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new OrgClickHouseApplySchemaResult({ applied, skipped })
		})

		const resolveRuntimeConfig = Effect.fn("OrgClickHouseSettingsService.resolveRuntimeConfig")(
			function* (orgId: OrgId) {
				const row = yield* selectActiveRow(orgId)
				if (Option.isNone(row)) {
					return Option.none<RuntimeBackendConfig>()
				}
				const password = yield* decryptStoredPassword(row.value)
				return Option.some<RuntimeBackendConfig>({
					backend: "clickhouse",
					url: row.value.chUrl,
					user: row.value.chUser,
					password,
					database: row.value.chDatabase,
				})
			},
		)

		const collectorConfig = Effect.fn("OrgClickHouseSettingsService.collectorConfig")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const yaml = renderCollectorYaml({
				orgId,
				endpoint: row.chUrl,
				user: row.chUser,
				database: row.chDatabase,
			})
			return new OrgClickHouseCollectorConfigResponse({
				yaml,
				image: COLLECTOR_IMAGE_REF,
				passwordEnvVar: COLLECTOR_PASSWORD_ENV,
			})
		})

		return {
			get,
			upsert,
			delete: deleteSettings,
			schemaDiff,
			applySchema,
			resolveRuntimeConfig,
			collectorConfig,
		} satisfies OrgClickHouseSettingsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly get = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.get(orgId, roles))

	static readonly upsert = (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => this.use((service) => service.upsert(orgId, userId, roles, payload))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))

	static readonly resolveRuntimeConfig = (orgId: OrgId) =>
		this.use((service) => service.resolveRuntimeConfig(orgId))

	static readonly collectorConfig = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.collectorConfig(orgId, roles))
}
