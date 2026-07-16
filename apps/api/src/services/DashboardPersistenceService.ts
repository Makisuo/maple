import {
	DashboardConcurrencyError,
	DashboardDeleteResponse,
	DashboardId,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardValidationError,
	DashboardDocument,
	DashboardsListResponse,
	DashboardVersionDetail,
	DashboardVersionId,
	DashboardVersionNotFoundError,
	DashboardVersionsListResponse,
	DashboardVersionSummary,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	type PostgresTransactionId,
	UserId,
} from "@maple/domain/http"
import { dashboards, dashboardVersions, type DashboardVersionRow } from "@maple/db"
import { and, desc, eq, lt } from "drizzle-orm"
import { Clock, Effect, Layer, Option, Schema, Context } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "../lib/DatabaseLive"
import { readTxid, txidColumn } from "../lib/electric-txid"
import { summarizeDashboardChange } from "./dashboard-changes"

const decodeDashboardIdSync = Schema.decodeUnknownSync(DashboardId)
const decodeDashboardVersionIdSync = Schema.decodeUnknownSync(DashboardVersionId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

const COALESCE_WINDOW_MS = 5_000

// Optimistic-locking retry budget for `mutate`. Each attempt re-reads the
// current dashboard, re-applies the caller's transform on top of it, and
// attempts a compare-and-swap on (id, version). Five attempts is enough for
// genuine contention; if we still can't win the CAS we surface the conflict
// to the caller so they can refetch and retry at their own pace.
const MUTATE_MAX_ATTEMPTS = 5

const toPersistenceError = (error: unknown) =>
	new DashboardPersistenceError({
		message: error instanceof Error ? error.message : "Dashboard persistence failed",
	})

const parseTimestamp = (field: "createdAt" | "updatedAt", value: string) => {
	const timestamp = Date.parse(value)

	if (!Number.isFinite(timestamp)) {
		return Effect.fail(
			new DashboardValidationError({
				message: `Invalid ${field} timestamp`,
				details: [`${field} must be an ISO date-time string`],
			}),
		)
	}

	return Effect.succeed(timestamp)
}

const parsePayload = (payloadJson: unknown) =>
	Schema.decodeUnknownEffect(DashboardDocument)(payloadJson).pipe(
		Effect.mapError(
			() =>
				new DashboardPersistenceError({
					message: "Stored dashboard payload is invalid JSON",
				}),
		),
	)

// jsonb columns take the document object directly; this guard preserves the
// pre-Postgres validation that the payload is JSON-serializable before write.
const validatePayload = Effect.fnUntraced(function* (dashboard: DashboardDocument) {
	const names = (dashboard.variables ?? []).map((variable) => variable.name)
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
	if (duplicates.length > 0) {
		return yield* new DashboardValidationError({
			message: "Dashboard variable names must be unique",
			details: [...new Set(duplicates)].map((name) => `Duplicate variable name: ${name}`),
		})
	}

	return yield* Effect.try({
		try: () => {
			JSON.stringify(dashboard)
			// `txid` is a transport-only field carried on mutation responses; it must
			// never be persisted into `payload_json` (nor a version snapshot). Strip
			// it here — the single choke point for every jsonb write — so a client
			// that echoes it back in an upsert payload can't leak it into storage.
			if (dashboard.txid === undefined) return dashboard
			const { txid: _txid, ...rest } = dashboard
			return new DashboardDocument({ ...rest })
		},
		catch: () =>
			new DashboardValidationError({
				message: "Dashboard payload must be JSON serializable",
				details: ["Dashboard contains non-serializable values"],
			}),
	})
})

const createDashboardDocument = (portableDashboard: PortableDashboardDocument, nowMillis: number) => {
	const now = new Date(nowMillis).toISOString()

	return new DashboardDocument({
		id: decodeDashboardIdSync(randomUUID()),
		name: portableDashboard.name,
		// `description`/`tags` are `Schema.optionalKey`; the Schema.Class constructor
		// rejects a present `undefined`. Omit the key when the portable source has none.
		...(portableDashboard.description !== undefined && {
			description: portableDashboard.description,
		}),
		...(portableDashboard.tags !== undefined && { tags: portableDashboard.tags }),
		...(portableDashboard.variables !== undefined && { variables: portableDashboard.variables }),
		timeRange: portableDashboard.timeRange,
		widgets: portableDashboard.widgets,
		createdAt: decodeIsoDateTimeStringSync(now),
		updatedAt: decodeIsoDateTimeStringSync(now),
	})
}

const versionRowToSummary = (row: DashboardVersionRow): DashboardVersionSummary =>
	new DashboardVersionSummary({
		id: decodeDashboardVersionIdSync(row.id),
		dashboardId: decodeDashboardIdSync(row.dashboardId),
		versionNumber: row.versionNumber,
		changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
		changeSummary: row.changeSummary ?? null,
		sourceVersionId: row.sourceVersionId ? decodeDashboardVersionIdSync(row.sourceVersionId) : null,
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		createdBy: decodeUserIdSync(row.createdBy),
	})

type VersionOptions = {
	readonly forceKind?: DashboardVersionSummary["changeKind"]
	readonly forceSummary?: string
	readonly sourceVersionId?: DashboardVersionId | null
}

export interface DashboardPersistenceServiceShape {
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		dashboard: PortableDashboardDocument,
	) => Effect.Effect<
		DashboardDocument,
		DashboardValidationError | DashboardPersistenceError | DashboardConcurrencyError
	>
	readonly list: (orgId: OrgId) => Effect.Effect<DashboardsListResponse, DashboardPersistenceError>
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		dashboard: DashboardDocument,
	) => Effect.Effect<
		DashboardDocument,
		DashboardValidationError | DashboardPersistenceError | DashboardConcurrencyError
	>
	readonly mutate: <E, R>(
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		transform: (dashboard: DashboardDocument) => Effect.Effect<DashboardDocument, E, R>,
		versionOptions?: VersionOptions,
	) => Effect.Effect<
		DashboardDocument,
		| E
		| DashboardNotFoundError
		| DashboardValidationError
		| DashboardConcurrencyError
		| DashboardPersistenceError,
		R
	>
	readonly delete: (
		orgId: OrgId,
		dashboardId: DashboardId,
	) => Effect.Effect<DashboardDeleteResponse, DashboardPersistenceError | DashboardNotFoundError>
	readonly listVersions: (
		orgId: OrgId,
		dashboardId: DashboardId,
		options?: { readonly limit?: number; readonly before?: number },
	) => Effect.Effect<DashboardVersionsListResponse, DashboardPersistenceError | DashboardNotFoundError>
	readonly getVersion: (
		orgId: OrgId,
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
	) => Effect.Effect<
		DashboardVersionDetail,
		DashboardPersistenceError | DashboardNotFoundError | DashboardVersionNotFoundError
	>
	readonly restoreVersion: (
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
	) => Effect.Effect<
		DashboardDocument,
		| DashboardPersistenceError
		| DashboardNotFoundError
		| DashboardVersionNotFoundError
		| DashboardValidationError
		| DashboardConcurrencyError
	>
}

export class DashboardPersistenceService extends Context.Service<
	DashboardPersistenceService,
	DashboardPersistenceServiceShape
>()(
	"@maple/api/services/DashboardPersistenceService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const loadCurrent = Effect.fn("DashboardPersistenceService.loadCurrent")(function* (
				orgId: OrgId,
				dashboardId: DashboardId,
			) {
					const rows: ReadonlyArray<{
						readonly payloadJson: unknown
						readonly version: number
					}> = yield* database
						.execute((db) =>
							db
								.select({
									payloadJson: dashboards.payloadJson,
									version: dashboards.version,
								})
								.from(dashboards)
								.where(and(eq(dashboards.orgId, orgId), eq(dashboards.id, dashboardId))),
						)
						.pipe(Effect.mapError(toPersistenceError))

					const row = rows[0]
					if (!row) return null
					const document = yield* parsePayload(row.payloadJson)
					return { document, version: row.version }
				})

			const recordVersion = Effect.fn("DashboardPersistenceService.recordVersion")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboard: DashboardDocument,
				previous: DashboardDocument | null,
				options: VersionOptions = {},
			) {
					const summary = summarizeDashboardChange(previous, dashboard)
					const kind = options.forceKind ?? summary.kind
					const summaryText = options.forceSummary ?? summary.summary
					const snapshotJson = yield* validatePayload(dashboard)
					const now = yield* Clock.currentTimeMillis

					const latest: ReadonlyArray<DashboardVersionRow> = yield* database
						.execute((db) =>
							db
								.select()
								.from(dashboardVersions)
								.where(
									and(
										eq(dashboardVersions.orgId, orgId),
										eq(dashboardVersions.dashboardId, dashboard.id),
									),
								)
								.orderBy(desc(dashboardVersions.versionNumber))
								.limit(1),
						)
						.pipe(Effect.mapError(toPersistenceError))

					const latestRow = latest[0]
					const canCoalesce =
						!options.sourceVersionId &&
						!options.forceKind &&
						latestRow !== undefined &&
						latestRow.createdBy === userId &&
						latestRow.changeKind === kind &&
						now - latestRow.createdAt.getTime() < COALESCE_WINDOW_MS

					if (canCoalesce && latestRow) {
						yield* database
							.execute((db) =>
								db
									.update(dashboardVersions)
									.set({
										snapshotJson,
										changeSummary: summaryText,
										createdAt: new Date(now),
									})
									.where(
										and(
											eq(dashboardVersions.orgId, orgId),
											eq(dashboardVersions.id, latestRow.id),
										),
									),
							)
							.pipe(Effect.mapError(toPersistenceError))
						return
					}

					const versionNumber = (latestRow?.versionNumber ?? 0) + 1

					yield* database
						.execute((db) =>
							db.insert(dashboardVersions).values({
								orgId,
								id: randomUUID(),
								dashboardId: dashboard.id,
								versionNumber,
								snapshotJson,
								changeKind: kind,
								changeSummary: summaryText,
								sourceVersionId: options.sourceVersionId ?? null,
								createdAt: new Date(now),
								createdBy: userId,
							}),
						)
						.pipe(Effect.mapError(toPersistenceError))
				})

			const list = Effect.fn("DashboardPersistenceService.list")(function* (orgId: OrgId) {
				const rows: ReadonlyArray<{ readonly payloadJson: unknown }> = yield* database
					.execute((db) =>
						db
							.select({
								payloadJson: dashboards.payloadJson,
							})
							.from(dashboards)
							.where(eq(dashboards.orgId, orgId))
							.orderBy(desc(dashboards.updatedAt)),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const dashboardDocuments = yield* Effect.forEach(rows, (row) => parsePayload(row.payloadJson))

				return new DashboardsListResponse({ dashboards: dashboardDocuments })
			})

			// Compare-and-swap update against `dashboards.version`. Returns
			// `true` when the row was updated (we won the CAS), `false` when
			// the expected version no longer matches (a concurrent writer beat
			// us). The history snapshot insert is best-effort and runs only
			// after the CAS update succeeds, so a stale conflicting attempt
			// never produces a phantom audit row.
			const tryCasUpdate = Effect.fn("DashboardPersistenceService.tryCasUpdate")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboard: DashboardDocument,
				expectedVersion: number,
				updatedAt: number,
				payloadJson: DashboardDocument,
			) {
					const updated: ReadonlyArray<{ readonly id: string; readonly txid: string }> =
						yield* database
							.execute((db) =>
								db
									.update(dashboards)
									.set({
										name: dashboard.name,
										payloadJson,
										updatedAt: new Date(updatedAt),
										updatedBy: userId,
										version: expectedVersion + 1,
									})
									.where(
										and(
											eq(dashboards.orgId, orgId),
											eq(dashboards.id, dashboard.id),
											eq(dashboards.version, expectedVersion),
										),
									)
									.returning({ id: dashboards.id, ...txidColumn }),
							)
							.pipe(Effect.mapError(toPersistenceError))

					return { won: updated.length > 0, txid: readTxid(updated) }
				})

			const insertNew = (
				orgId: OrgId,
				userId: UserId,
				dashboard: DashboardDocument,
				createdAt: number,
				updatedAt: number,
				payloadJson: DashboardDocument,
			) =>
				database
					.execute((db) =>
						db
							.insert(dashboards)
							.values({
								orgId,
								id: dashboard.id,
								name: dashboard.name,
								payloadJson,
								createdAt: new Date(createdAt),
								updatedAt: new Date(updatedAt),
								createdBy: userId,
								updatedBy: userId,
								version: 1,
							})
							.returning(txidColumn),
					)
					.pipe(
						Effect.mapError(toPersistenceError),
						Effect.map(readTxid),
					)

			const upsertInternal = Effect.fn("DashboardPersistenceService.upsertInternal")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboard: DashboardDocument,
				versionOptions: VersionOptions = {},
			) {
					const payloadJson = yield* validatePayload(dashboard)
					const createdAt = yield* parseTimestamp("createdAt", dashboard.createdAt)
					const updatedAt = yield* parseTimestamp("updatedAt", dashboard.updatedAt)

					const current = yield* loadCurrent(orgId, dashboard.id)

					let txid: PostgresTransactionId | undefined
					if (current === null) {
						txid = yield* insertNew(orgId, userId, dashboard, createdAt, updatedAt, payloadJson)
					} else {
						const result = yield* tryCasUpdate(
							orgId,
							userId,
							dashboard,
							current.version,
							updatedAt,
							payloadJson,
						)
						if (!result.won) {
							return yield* Effect.fail(
								new DashboardConcurrencyError({
									dashboardId: dashboard.id,
									message:
										"Dashboard was modified by another writer. Refetch and try again.",
								}),
							)
						}
						txid = result.txid
					}

					// History recording is best-effort: a failure here must not roll
					// back the dashboard write. The dashboard table is the source of
					// truth; versions are an append-only audit trail.
					yield* recordVersion(
						orgId,
						userId,
						dashboard,
						current?.document ?? null,
						versionOptions,
					).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Failed to record dashboard version").pipe(
								Effect.annotateLogs({ dashboardId: dashboard.id, error: String(error) }),
							),
						),
						Effect.ignore,
					)

					// Attach the write's txid only to the returned document — never to
					// the stored payload or version snapshot, which were computed above
					// from the txid-free input.
					return txid === undefined ? dashboard : new DashboardDocument({ ...dashboard, txid })
				})

			const upsert = Effect.fn("DashboardPersistenceService.upsert")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboard: DashboardDocument,
			) {
				return yield* upsertInternal(orgId, userId, dashboard)
			})

			const create = Effect.fn("DashboardPersistenceService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboard: PortableDashboardDocument,
			) {
				const nowMillis = yield* Clock.currentTimeMillis
				const createdDashboard = createDashboardDocument(dashboard, nowMillis)
				return yield* upsertInternal(orgId, userId, createdDashboard)
			})

			// Read-modify-write helper used by the MCP dashboard tools. Loads
			// the current dashboard, runs the caller's transform on top of it,
			// and attempts a compare-and-swap update. On CAS conflict (a
			// concurrent writer slipped in between read and write) we re-read
			// and re-apply the transform up to MUTATE_MAX_ATTEMPTS times before
			// giving up with a typed `DashboardConcurrencyError`. This is the
			// pattern that prevents lost updates between concurrent MCP tool
			// calls and HTTP edits.
			const mutate = Effect.fn("DashboardPersistenceService.mutate")(function* <E, R>(
				orgId: OrgId,
				userId: UserId,
				dashboardId: DashboardId,
				transform: (dashboard: DashboardDocument) => Effect.Effect<DashboardDocument, E, R>,
				versionOptions: VersionOptions = {},
			) {
				for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
					const current = yield* loadCurrent(orgId, dashboardId)
					if (current === null) {
						return yield* Effect.fail(
							new DashboardNotFoundError({
								dashboardId,
								message: "Dashboard not found",
							}),
						)
					}

					const next = yield* transform(current.document)
					const payloadJson = yield* validatePayload(next)
					const updatedAt = yield* parseTimestamp("updatedAt", next.updatedAt)

					const result = yield* tryCasUpdate(
						orgId,
						userId,
						next,
						current.version,
						updatedAt,
						payloadJson,
					)
					if (!result.won) continue

					yield* recordVersion(orgId, userId, next, current.document, versionOptions).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Failed to record dashboard version").pipe(
								Effect.annotateLogs({ dashboardId, error: String(error) }),
							),
						),
						Effect.ignore,
					)

					return result.txid === undefined ? next : new DashboardDocument({ ...next, txid: result.txid })
				}

				return yield* Effect.fail(
					new DashboardConcurrencyError({
						dashboardId,
						message:
							"Dashboard mutation failed after repeated concurrency conflicts. Refetch and try again.",
					}),
				)
			})

			const remove = Effect.fn("DashboardPersistenceService.delete")(function* (
				orgId: OrgId,
				dashboardId: DashboardId,
			) {
				const rows = yield* database
					.execute((db) =>
						db
							.delete(dashboards)
							.where(and(eq(dashboards.orgId, orgId), eq(dashboards.id, dashboardId)))
							.returning({ id: dashboards.id, ...txidColumn }),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const deleted = Option.fromNullishOr(rows[0])

				if (Option.isNone(deleted)) {
					return yield* Effect.fail(
						new DashboardNotFoundError({
							dashboardId,
							message: "Dashboard not found",
						}),
					)
				}

				const txid = readTxid(rows)

				// Drop history rows when the dashboard is deleted — they're tied to
				// a dashboard that no longer exists.
				yield* database
					.execute((db) =>
						db
							.delete(dashboardVersions)
							.where(
								and(
									eq(dashboardVersions.orgId, orgId),
									eq(dashboardVersions.dashboardId, dashboardId),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))

				return new DashboardDeleteResponse({
					id: decodeDashboardIdSync(deleted.value.id),
					...(txid !== undefined && { txid }),
				})
			})

			const ensureDashboardExists = Effect.fn("DashboardPersistenceService.ensureDashboardExists")(
				function* (orgId: OrgId, dashboardId: DashboardId) {
					const current = yield* loadCurrent(orgId, dashboardId)
					if (current === null) {
						return yield* Effect.fail(
							new DashboardNotFoundError({
								dashboardId,
								message: "Dashboard not found",
							}),
						)
					}
					return current.document
				})

			const listVersions = Effect.fn("DashboardPersistenceService.listVersions")(function* (
				orgId: OrgId,
				dashboardId: DashboardId,
				options: {
					readonly limit?: number
					readonly before?: number
				} = {},
			) {
				yield* ensureDashboardExists(orgId, dashboardId)

				const limit = Math.min(options.limit ?? 50, 200)
				const conditions = [
					eq(dashboardVersions.orgId, orgId),
					eq(dashboardVersions.dashboardId, dashboardId),
				]
				if (options.before !== undefined) {
					conditions.push(lt(dashboardVersions.versionNumber, options.before))
				}

				const rows: ReadonlyArray<DashboardVersionRow> = yield* database
					.execute((db) =>
						db
							.select()
							.from(dashboardVersions)
							.where(and(...conditions))
							.orderBy(desc(dashboardVersions.versionNumber))
							.limit(limit + 1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const hasMore = rows.length > limit
				const sliced = hasMore ? rows.slice(0, limit) : rows

				return new DashboardVersionsListResponse({
					versions: sliced.map(versionRowToSummary),
					hasMore,
				})
			})

			const getVersion = Effect.fn("DashboardPersistenceService.getVersion")(function* (
				orgId: OrgId,
				dashboardId: DashboardId,
				versionId: DashboardVersionId,
			) {
				yield* ensureDashboardExists(orgId, dashboardId)

				const rows: ReadonlyArray<DashboardVersionRow> = yield* database
					.execute((db) =>
						db
							.select()
							.from(dashboardVersions)
							.where(
								and(eq(dashboardVersions.orgId, orgId), eq(dashboardVersions.id, versionId)),
							)
							.limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const row = rows[0]
				if (!row || row.dashboardId !== dashboardId) {
					return yield* Effect.fail(
						new DashboardVersionNotFoundError({
							dashboardId,
							versionId,
							message: "Dashboard version not found",
						}),
					)
				}

				const snapshot = yield* parsePayload(row.snapshotJson)

				return new DashboardVersionDetail({
					id: decodeDashboardVersionIdSync(row.id),
					dashboardId: decodeDashboardIdSync(row.dashboardId),
					versionNumber: row.versionNumber,
					changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
					changeSummary: row.changeSummary ?? null,
					sourceVersionId: row.sourceVersionId
						? decodeDashboardVersionIdSync(row.sourceVersionId)
						: null,
					createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
					createdBy: decodeUserIdSync(row.createdBy),
					snapshot,
				})
			})

			const restoreVersion = Effect.fn("DashboardPersistenceService.restoreVersion")(function* (
				orgId: OrgId,
				userId: UserId,
				dashboardId: DashboardId,
				versionId: DashboardVersionId,
			) {
				const detail = yield* getVersion(orgId, dashboardId, versionId)

				const nowIso = decodeIsoDateTimeStringSync(
					new Date(yield* Clock.currentTimeMillis).toISOString(),
				)
				const restored = new DashboardDocument({
					...detail.snapshot,
					updatedAt: nowIso,
				})

				return yield* upsertInternal(orgId, userId, restored, {
					forceKind: "restored",
					forceSummary: `Restored from v${detail.versionNumber}`,
					sourceVersionId: detail.id,
				})
			})

			return {
				create,
				list,
				upsert,
				mutate,
				delete: remove,
				listVersions,
				getVersion,
				restoreVersion,
			} satisfies DashboardPersistenceServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly list = (orgId: OrgId) => this.use((service) => service.list(orgId))

	static readonly create = (orgId: OrgId, userId: UserId, dashboard: PortableDashboardDocument) =>
		this.use((service) => service.create(orgId, userId, dashboard))

	static readonly upsert = (orgId: OrgId, userId: UserId, dashboard: DashboardDocument) =>
		this.use((service) => service.upsert(orgId, userId, dashboard))

	static readonly mutate = <E, R>(
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		transform: (dashboard: DashboardDocument) => Effect.Effect<DashboardDocument, E, R>,
	) => this.use((service) => service.mutate(orgId, userId, dashboardId, transform))

	static readonly delete = (orgId: OrgId, dashboardId: DashboardId) =>
		this.use((service) => service.delete(orgId, dashboardId))

	static readonly listVersions = (
		orgId: OrgId,
		dashboardId: DashboardId,
		options?: { readonly limit?: number; readonly before?: number },
	) => this.use((service) => service.listVersions(orgId, dashboardId, options))

	static readonly getVersion = (orgId: OrgId, dashboardId: DashboardId, versionId: DashboardVersionId) =>
		this.use((service) => service.getVersion(orgId, dashboardId, versionId))

	static readonly restoreVersion = (
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
	) => this.use((service) => service.restoreVersion(orgId, userId, dashboardId, versionId))
}
