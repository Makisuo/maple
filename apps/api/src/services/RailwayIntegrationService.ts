import { randomUUID } from "node:crypto"
import {
	CreateRailwayTargetRequest,
	IsoDateTimeString,
	OrgId,
	RailwayConnectionId,
	RailwayDiscoveredEnvironment,
	RailwayDiscoveredProject,
	RailwayDiscoveredService,
	RailwayDiscoveryResponse,
	RailwayDisconnectResponse,
	RailwayEncryptionError,
	RailwayIntegrationStatus,
	RailwayMetricsIntervalSeconds,
	RailwayNotFoundError,
	RailwayPersistenceError,
	RailwayTargetDeleteResponse,
	RailwayTargetId,
	RailwayTargetResponse,
	RailwayTargetsListResponse,
	RailwayTokenType,
	RailwayUpstreamError,
	RailwayValidationError,
	type RailwayResultReport,
	type UpdateRailwayTargetRequest,
} from "@maple/domain/http"
import { railwayConnections, railwayTargets, type RailwayConnectionRow, type RailwayTargetRow } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import {
	fetchRailwayProjects,
	RailwayApiRequestError,
	validateRailwayToken,
	type RailwayDiscoveredProjectData,
} from "../lib/RailwayApi"

const DEFAULT_METRICS_INTERVAL_SECONDS = 300
/** Cached environment→services lists refresh at most this often (one discovery call per connection). */
const SERVICES_REFRESH_TTL_MS = 60 * 60 * 1000

const decodeConnectionIdSync = Schema.decodeUnknownSync(RailwayConnectionId)
const decodeTargetIdSync = Schema.decodeUnknownSync(RailwayTargetId)
const decodeTokenTypeSync = Schema.decodeUnknownSync(RailwayTokenType)
const decodeMetricsIntervalSync = Schema.decodeUnknownSync(RailwayMetricsIntervalSeconds)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

const ServicesJsonSchema = Schema.Array(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
	}),
)
const decodeServicesJson = Schema.decodeUnknownSync(Schema.fromJsonString(ServicesJsonSchema))

/** Parse a target's cached services list; corrupt JSON degrades to an empty list. */
export const parseServicesJson = (
	servicesJson: string | null,
): ReadonlyArray<{ readonly id: string; readonly name: string }> => {
	if (servicesJson === null) return []
	try {
		return decodeServicesJson(servicesJson)
	} catch {
		return []
	}
}

/** The internal wire row handed to the railway-connector (before ingest keys are attached). */
export interface EnabledRailwayTarget {
	readonly target: RailwayTargetRow
	readonly connection: RailwayConnectionRow
	/** Decrypted Railway API token. */
	readonly token: string
	readonly services: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export interface RailwayIntegrationServiceShape {
	readonly status: (orgId: OrgId) => Effect.Effect<RailwayIntegrationStatus, RailwayPersistenceError>
	readonly connect: (
		orgId: OrgId,
		userId: string,
		token: string,
	) => Effect.Effect<
		RailwayIntegrationStatus,
		RailwayValidationError | RailwayUpstreamError | RailwayPersistenceError | RailwayEncryptionError
	>
	readonly disconnect: (orgId: OrgId) => Effect.Effect<RailwayDisconnectResponse, RailwayPersistenceError>
	readonly discover: (
		orgId: OrgId,
	) => Effect.Effect<
		RailwayDiscoveryResponse,
		RailwayNotFoundError | RailwayUpstreamError | RailwayPersistenceError | RailwayEncryptionError
	>
	readonly listTargets: (
		orgId: OrgId,
	) => Effect.Effect<RailwayTargetsListResponse, RailwayPersistenceError>
	readonly createTarget: (
		orgId: OrgId,
		request: CreateRailwayTargetRequest,
	) => Effect.Effect<
		RailwayTargetResponse,
		| RailwayNotFoundError
		| RailwayValidationError
		| RailwayUpstreamError
		| RailwayPersistenceError
		| RailwayEncryptionError
	>
	readonly updateTarget: (
		orgId: OrgId,
		targetId: RailwayTargetId,
		request: UpdateRailwayTargetRequest,
	) => Effect.Effect<
		RailwayTargetResponse,
		RailwayNotFoundError | RailwayValidationError | RailwayPersistenceError
	>
	readonly deleteTarget: (
		orgId: OrgId,
		targetId: RailwayTargetId,
	) => Effect.Effect<RailwayTargetDeleteResponse, RailwayNotFoundError | RailwayPersistenceError>
	/**
	 * Work list for the railway-connector: every enabled target of every enabled
	 * connection, with the connection token decrypted and the cached services
	 * list refreshed on a TTL. Rows that fail decryption are skipped (logged)
	 * so one corrupt connection cannot break the whole list.
	 */
	readonly listAllEnabledInternal: () => Effect.Effect<
		ReadonlyArray<EnabledRailwayTarget>,
		RailwayPersistenceError
	>
	readonly recordResults: (
		reports: ReadonlyArray<RailwayResultReport>,
	) => Effect.Effect<void, RailwayPersistenceError>
}

const toPersistenceError = (error: unknown) =>
	new RailwayPersistenceError({
		message: error instanceof Error ? error.message : "Railway integration persistence failed",
	})

const toEncryptionError = (message: string) => new RailwayEncryptionError({ message })

const mapRailwayApiError = (error: RailwayApiRequestError): RailwayUpstreamError =>
	new RailwayUpstreamError({ message: error.message })

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, RailwayEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const iso = (date: Date | null): IsoDateTimeString | null =>
	date === null ? null : decodeIsoDateTimeStringSync(date.toISOString())

const rowToTargetResponse = (row: RailwayTargetRow): RailwayTargetResponse =>
	new RailwayTargetResponse({
		id: decodeTargetIdSync(row.id),
		projectId: row.projectId,
		projectName: row.projectName,
		environmentId: row.environmentId,
		environmentName: row.environmentName,
		enabled: row.enabled,
		logsEnabled: row.logsEnabled,
		metricsEnabled: row.metricsEnabled,
		metricsIntervalSeconds: decodeMetricsIntervalSync(row.metricsIntervalSeconds),
		serviceCount: parseServicesJson(row.servicesJson).length,
		lastLogAt: iso(row.lastLogAt),
		lastMetricsAt: iso(row.lastMetricsAt),
		lastSuccessAt: iso(row.lastSuccessAt),
		lastError: row.lastError,
		lastErrorAt: iso(row.lastErrorAt),
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
	})

export class RailwayIntegrationService extends Context.Service<
	RailwayIntegrationService,
	RailwayIntegrationServiceShape
>()("@maple/api/services/RailwayIntegrationService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))

		const selectConnection = Effect.fn("RailwayIntegrationService.selectConnection")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db.select().from(railwayConnections).where(eq(railwayConnections.orgId, orgId)).limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return Option.fromNullishOr(rows[0])
		})

		const requireConnection = Effect.fn("RailwayIntegrationService.requireConnection")(function* (
			orgId: OrgId,
		) {
			const connection = yield* selectConnection(orgId)
			if (Option.isSome(connection)) return connection.value
			return yield* Effect.fail(
				new RailwayNotFoundError({ message: "Railway is not connected for this organization" }),
			)
		})

		const decryptToken = (
			row: RailwayConnectionRow,
		): Effect.Effect<string, RailwayEncryptionError> =>
			decryptAes256Gcm(
				{ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
				encryptionKey,
				() => toEncryptionError("Failed to decrypt the stored Railway token"),
			)

		const selectTargets = Effect.fn("RailwayIntegrationService.selectTargets")(function* (
			orgId: OrgId,
		) {
			return yield* database
				.execute((db) => db.select().from(railwayTargets).where(eq(railwayTargets.orgId, orgId)))
				.pipe(Effect.mapError(toPersistenceError))
		})

		const requireTarget = Effect.fn("RailwayIntegrationService.requireTarget")(function* (
			orgId: OrgId,
			targetId: RailwayTargetId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(railwayTargets)
						.where(and(eq(railwayTargets.orgId, orgId), eq(railwayTargets.id, targetId)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isSome(row)) return row.value
			return yield* Effect.fail(new RailwayNotFoundError({ message: "Railway target not found" }))
		})

		const statusFor = Effect.fn("RailwayIntegrationService.statusFor")(function* (orgId: OrgId) {
			const connection = yield* selectConnection(orgId)
			const targets = yield* selectTargets(orgId)
			const erroredTargetCount = targets.filter((target) => target.lastError !== null).length
			return Option.match(connection, {
				onNone: () =>
					new RailwayIntegrationStatus({
						connected: false,
						connectionId: null,
						tokenType: null,
						accountName: null,
						enabled: false,
						lastValidatedAt: null,
						lastValidationError: null,
						targetCount: targets.length,
						erroredTargetCount,
					}),
				onSome: (row) =>
					new RailwayIntegrationStatus({
						connected: true,
						connectionId: decodeConnectionIdSync(row.id),
						tokenType: decodeTokenTypeSync(row.tokenType),
						accountName: row.externalAccountName,
						enabled: row.enabled,
						lastValidatedAt: iso(row.lastValidatedAt),
						lastValidationError: row.lastValidationError,
						targetCount: targets.length,
						erroredTargetCount,
					}),
			})
		})

		const connect = Effect.fn("RailwayIntegrationService.connect")(function* (
			orgId: OrgId,
			userId: string,
			token: string,
		) {
			const trimmed = token.trim()
			if (trimmed.length === 0) {
				return yield* Effect.fail(new RailwayValidationError({ message: "A Railway API token is required" }))
			}

			const identity = yield* validateRailwayToken(trimmed).pipe(
				Effect.mapError((error) =>
					error.unauthorized
						? new RailwayValidationError({
								message:
									"Railway rejected the token. Paste a workspace or account API token from Railway → Account Settings → Tokens.",
							})
						: mapRailwayApiError(error),
				),
			)

			const encrypted = yield* encryptAes256Gcm(trimmed, encryptionKey, () =>
				toEncryptionError("Failed to encrypt the Railway token"),
			)

			const now = yield* Clock.currentTimeMillis
			const values = {
				tokenType: identity.tokenType,
				tokenCiphertext: encrypted.ciphertext,
				tokenIv: encrypted.iv,
				tokenTag: encrypted.tag,
				externalAccountName: identity.accountName,
				connectedByUserId: userId,
				enabled: true,
				lastValidatedAt: new Date(now),
				lastValidationError: null,
				lastValidationErrorAt: null,
			}
			yield* database
				.execute((db) =>
					db
						.insert(railwayConnections)
						.values({
							id: randomUUID(),
							orgId,
							createdAt: new Date(now),
							updatedAt: new Date(now),
							...values,
						})
						.onConflictDoUpdate({
							target: [railwayConnections.orgId],
							set: { ...values, updatedAt: new Date(now) },
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return yield* statusFor(orgId)
		})

		const disconnect = Effect.fn("RailwayIntegrationService.disconnect")(function* (orgId: OrgId) {
			yield* database
				.execute((db) => db.delete(railwayTargets).where(eq(railwayTargets.orgId, orgId)))
				.pipe(Effect.mapError(toPersistenceError))
			const deleted = yield* database
				.execute((db) =>
					db
						.delete(railwayConnections)
						.where(eq(railwayConnections.orgId, orgId))
						.returning({ id: railwayConnections.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return new RailwayDisconnectResponse({ disconnected: deleted.length > 0 })
		})

		const discoverProjects = Effect.fn("RailwayIntegrationService.discoverProjects")(function* (
			connection: RailwayConnectionRow,
		) {
			const token = yield* decryptToken(connection)
			return yield* fetchRailwayProjects(token).pipe(
				Effect.tapError((error) =>
					Effect.gen(function* () {
						// Best-effort revocation surfacing; the caller still sees the
						// upstream error. Only a genuine auth rejection flags the
						// connection — a transient Railway outage (timeout, 5xx, DNS)
						// must not flip the card to "Reconnect needed".
						if (!error.unauthorized) return
						const now = yield* Clock.currentTimeMillis
						yield* database
							.execute((db) =>
								db
									.update(railwayConnections)
									.set({
										lastValidationError: "Railway rejected the stored token",
										lastValidationErrorAt: new Date(now),
										updatedAt: new Date(now),
									})
									.where(eq(railwayConnections.id, connection.id)),
							)
							.pipe(Effect.ignore)
					}),
				),
				Effect.mapError(mapRailwayApiError),
			)
		})

		const discover = Effect.fn("RailwayIntegrationService.discover")(function* (orgId: OrgId) {
			const connection = yield* requireConnection(orgId)
			const projects = yield* discoverProjects(connection)
			const targets = yield* selectTargets(orgId)
			const targetByEnv = new Map(
				targets.map((target) => [`${target.projectId}:${target.environmentId}`, target.id]),
			)

			// A successful discovery proves the token is still valid — clear any
			// stale revocation flag and bump lastValidatedAt.
			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.update(railwayConnections)
						.set({
							lastValidatedAt: new Date(now),
							lastValidationError: null,
							lastValidationErrorAt: null,
							updatedAt: new Date(now),
						})
						.where(eq(railwayConnections.id, connection.id)),
				)
				.pipe(Effect.ignore)

			return new RailwayDiscoveryResponse({
				projects: projects.map(
					(project) =>
						new RailwayDiscoveredProject({
							id: project.id,
							name: project.name,
							environments: project.environments.map(
								(environment) =>
									new RailwayDiscoveredEnvironment({
										id: environment.id,
										name: environment.name,
										services: environment.services.map(
											(service) =>
												new RailwayDiscoveredService({ id: service.id, name: service.name }),
										),
										targetId: (() => {
											const id = targetByEnv.get(`${project.id}:${environment.id}`)
											return id === undefined ? null : decodeTargetIdSync(id)
										})(),
									}),
							),
						}),
				),
			})
		})

		const listTargets = Effect.fn("RailwayIntegrationService.listTargets")(function* (orgId: OrgId) {
			const rows = yield* selectTargets(orgId)
			return new RailwayTargetsListResponse({ targets: rows.map(rowToTargetResponse) })
		})

		const createTarget = Effect.fn("RailwayIntegrationService.createTarget")(function* (
			orgId: OrgId,
			request: CreateRailwayTargetRequest,
		) {
			const connection = yield* requireConnection(orgId)
			const projects = yield* discoverProjects(connection)
			const project = projects.find((candidate) => candidate.id === request.projectId)
			if (project === undefined) {
				return yield* Effect.fail(
					new RailwayValidationError({
						message: "The Railway project was not found with the connected token",
					}),
				)
			}
			const environment = project.environments.find(
				(candidate) => candidate.id === request.environmentId,
			)
			if (environment === undefined) {
				return yield* Effect.fail(
					new RailwayValidationError({
						message: "The Railway environment was not found in that project",
					}),
				)
			}

			const now = yield* Clock.currentTimeMillis
			const id = randomUUID()
			const inserted = yield* database
				.execute((db) =>
					db
						.insert(railwayTargets)
						.values({
							id,
							orgId,
							connectionId: connection.id,
							projectId: project.id,
							projectName: project.name,
							environmentId: environment.id,
							environmentName: environment.name,
							enabled: true,
							logsEnabled: request.logsEnabled ?? true,
							metricsEnabled: request.metricsEnabled ?? true,
							metricsIntervalSeconds:
								request.metricsIntervalSeconds ?? DEFAULT_METRICS_INTERVAL_SECONDS,
							servicesJson: JSON.stringify(environment.services),
							servicesDiscoveredAt: new Date(now),
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})
						.onConflictDoNothing()
						.returning({ id: railwayTargets.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))

			if (inserted.length === 0) {
				return yield* Effect.fail(
					new RailwayValidationError({
						message: "This Railway environment is already being ingested",
					}),
				)
			}

			const row = yield* requireTarget(orgId, decodeTargetIdSync(id)).pipe(
				Effect.mapError(() =>
					new RailwayPersistenceError({ message: "Failed to load the created Railway target" }),
				),
			)
			return rowToTargetResponse(row)
		})

		const updateTarget = Effect.fn("RailwayIntegrationService.updateTarget")(function* (
			orgId: OrgId,
			targetId: RailwayTargetId,
			request: UpdateRailwayTargetRequest,
		) {
			yield* requireTarget(orgId, targetId)

			const now = yield* Clock.currentTimeMillis
			const updates: Partial<typeof railwayTargets.$inferInsert> = { updatedAt: new Date(now) }
			if (request.enabled !== undefined) updates.enabled = request.enabled
			if (request.logsEnabled !== undefined) updates.logsEnabled = request.logsEnabled
			if (request.metricsEnabled !== undefined) updates.metricsEnabled = request.metricsEnabled
			if (request.metricsIntervalSeconds !== undefined) {
				updates.metricsIntervalSeconds = request.metricsIntervalSeconds
			}

			yield* database
				.execute((db) =>
					db
						.update(railwayTargets)
						.set(updates)
						.where(and(eq(railwayTargets.orgId, orgId), eq(railwayTargets.id, targetId))),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* requireTarget(orgId, targetId)
			return rowToTargetResponse(row)
		})

		const deleteTarget = Effect.fn("RailwayIntegrationService.deleteTarget")(function* (
			orgId: OrgId,
			targetId: RailwayTargetId,
		) {
			const deleted = yield* database
				.execute((db) =>
					db
						.delete(railwayTargets)
						.where(and(eq(railwayTargets.orgId, orgId), eq(railwayTargets.id, targetId)))
						.returning({ id: railwayTargets.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = Option.fromNullishOr(deleted[0])
			if (Option.isNone(row)) {
				return yield* Effect.fail(new RailwayNotFoundError({ message: "Railway target not found" }))
			}
			return new RailwayTargetDeleteResponse({ id: decodeTargetIdSync(row.value.id) })
		})

		/** Refresh a connection's cached env→services lists when stale; best-effort. */
		const refreshServices = Effect.fn("RailwayIntegrationService.refreshServices")(function* (
			connection: RailwayConnectionRow,
			targets: ReadonlyArray<RailwayTargetRow>,
			now: number,
		) {
			const stale = targets.some(
				(target) =>
					target.servicesDiscoveredAt === null ||
					now - target.servicesDiscoveredAt.getTime() > SERVICES_REFRESH_TTL_MS,
			)
			if (!stale) return targets

			const projects = yield* discoverProjects(connection).pipe(Effect.option)
			if (Option.isNone(projects)) return targets

			const envById = new Map<string, RailwayDiscoveredProjectData["environments"][number]>()
			for (const project of projects.value) {
				for (const environment of project.environments) {
					envById.set(`${project.id}:${environment.id}`, environment)
				}
			}

			const refreshed: Array<RailwayTargetRow> = []
			for (const target of targets) {
				const environment = envById.get(`${target.projectId}:${target.environmentId}`)
				if (environment === undefined) {
					// Environment no longer visible with this token — keep the cached
					// list; the connector will surface errors if it truly disappeared.
					refreshed.push(target)
					continue
				}
				const servicesJson = JSON.stringify(environment.services)
				yield* database
					.execute((db) =>
						db
							.update(railwayTargets)
							.set({
								servicesJson,
								servicesDiscoveredAt: new Date(now),
								environmentName: environment.name,
								updatedAt: new Date(now),
							})
							.where(eq(railwayTargets.id, target.id)),
					)
					.pipe(Effect.ignore)
				refreshed.push({
					...target,
					servicesJson,
					servicesDiscoveredAt: new Date(now),
					environmentName: environment.name,
				})
			}
			return refreshed
		})

		const listAllEnabledInternal = Effect.fn("RailwayIntegrationService.listAllEnabledInternal")(
			function* () {
				const connections = yield* database
					.execute((db) =>
						db.select().from(railwayConnections).where(eq(railwayConnections.enabled, true)),
					)
					.pipe(Effect.mapError(toPersistenceError))
				if (connections.length === 0) return []

				const now = yield* Clock.currentTimeMillis
				const results: Array<EnabledRailwayTarget> = []

				yield* Effect.forEach(connections, (connection) =>
					Effect.gen(function* () {
						const token = yield* decryptToken(connection).pipe(Effect.option)
						if (Option.isNone(token)) {
							yield* Effect.logWarning("Skipping Railway connection (decryption failed)").pipe(
								Effect.annotateLogs({ railwayConnectionId: connection.id, orgId: connection.orgId }),
							)
							return
						}

						const targets = yield* database
							.execute((db) =>
								db
									.select()
									.from(railwayTargets)
									.where(
										and(
											eq(railwayTargets.connectionId, connection.id),
											eq(railwayTargets.enabled, true),
										),
									),
							)
							.pipe(Effect.orElseSucceed(() => [] as Array<RailwayTargetRow>))
						if (targets.length === 0) return

						const refreshed = yield* refreshServices(connection, targets, now)
						for (const target of refreshed) {
							results.push({
								target,
								connection,
								token: token.value,
								services: parseServicesJson(target.servicesJson),
							})
						}
					}),
				)

				return results
			},
		)

		const recordResults = Effect.fn("RailwayIntegrationService.recordResults")(function* (
			reports: ReadonlyArray<RailwayResultReport>,
		) {
			yield* Effect.forEach(
				reports,
				(report) =>
					Effect.gen(function* () {
						const rows = yield* database
							.execute((db) =>
								db
									.select()
									.from(railwayTargets)
									.where(eq(railwayTargets.id, report.targetId))
									.limit(1),
							)
							.pipe(Effect.mapError(toPersistenceError))
						const row = Option.fromNullishOr(rows[0])
						// Deleted targets can still be in-flight in the connector; drop their reports.
						if (Option.isNone(row)) return
						const target = row.value

						const at = new Date(report.at)
						const updates: Partial<typeof railwayTargets.$inferInsert> = { updatedAt: at }

						if (report.error === null) {
							updates.lastSuccessAt = at
							updates.lastError = null
							updates.lastErrorAt = null
							if (report.kind === "logs") updates.lastLogAt = at
							if (report.kind === "metrics") updates.lastMetricsAt = at
						} else {
							// Failure keeps last*At at the last good run so gaps stay visible.
							updates.lastError = `[${report.kind}] ${report.error}`
							updates.lastErrorAt = at
						}

						// Watermarks only ever move forward — late/out-of-order reports must
						// not rewind the backfill anchor.
						if (report.newLogWatermarkMs !== undefined) {
							const current = target.logWatermarkAt?.getTime() ?? 0
							if (report.newLogWatermarkMs > current) {
								updates.logWatermarkAt = new Date(report.newLogWatermarkMs)
							}
						}
						if (report.newMetricsWatermarkMs !== undefined) {
							const current = target.metricsWatermarkAt?.getTime() ?? 0
							if (report.newMetricsWatermarkMs > current) {
								updates.metricsWatermarkAt = new Date(report.newMetricsWatermarkMs)
							}
						}

						yield* database
							.execute((db) =>
								db.update(railwayTargets).set(updates).where(eq(railwayTargets.id, target.id)),
							)
							.pipe(Effect.mapError(toPersistenceError))

						if (report.unauthorized === true) {
							yield* database
								.execute((db) =>
									db
										.update(railwayConnections)
										.set({
											lastValidationError:
												"Railway rejected the stored token — reconnect the integration",
											lastValidationErrorAt: at,
											updatedAt: at,
										})
										.where(eq(railwayConnections.id, target.connectionId)),
								)
								.pipe(Effect.ignore)
						}
					}),
				{ discard: true },
			)
		})

		return {
			status: statusFor,
			connect,
			disconnect,
			discover,
			listTargets,
			createTarget,
			updateTarget,
			deleteTarget,
			listAllEnabledInternal,
			recordResults,
		} satisfies RailwayIntegrationServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
