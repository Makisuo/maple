import { randomUUID } from "node:crypto"
import { mobileDevices, type MobileDeviceRow } from "@maple/db"
import {
	MobileDeviceNotFoundError,
	MobileDevicePersistenceError,
	resolveMobileDevicePreferences,
	type MobilePlatform,
	type MobilePushEnvironment,
	type ResolvedMobileDevicePreferences,
} from "@maple/domain/http"
import { MobileDeviceId, type OrgId, type UserId } from "@maple/domain/primitives"
import { and, eq, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import { dateToMs, msToDate } from "@/platform/time"

/**
 * Registration and lookup for push-notification devices.
 *
 * Read paths (`listForOrg`) serve the alert fan-out and run inside the alerting
 * worker; write paths serve the app over `/v2/mobile_devices`. Both are here so
 * "which devices are live" has one definition.
 */

export interface MobileDevice {
	readonly id: MobileDeviceId
	readonly orgId: OrgId
	readonly userId: UserId
	readonly platform: MobilePlatform
	readonly token: string
	readonly environment: MobilePushEnvironment
	readonly bundleId: string
	readonly appVersion: string | null
	readonly deviceName: string | null
	/** ActivityKit push-to-start token, or null on a build/OS that has none. */
	readonly liveActivityStartToken: string | null
	readonly preferences: ResolvedMobileDevicePreferences
	readonly enabled: boolean
	readonly lastSeenAtMs: number
	readonly createdAtMs: number
}

export interface RegisterMobileDeviceInput {
	readonly platform: MobilePlatform
	readonly token: string
	readonly environment: MobilePushEnvironment
	readonly bundleId: string
	readonly appVersion?: string | undefined
	readonly deviceName?: string | undefined
	/** Absent keeps the stored token: an older app build must not erase it. */
	readonly liveActivityStartToken?: string | undefined
	/** Partial: absent keys keep the stored value (or the default on first registration). */
	readonly preferences?: Partial<ResolvedMobileDevicePreferences> | undefined
}

export interface MobileDevicesServiceApi {
	readonly register: (
		orgId: OrgId,
		userId: UserId,
		input: RegisterMobileDeviceInput,
	) => Effect.Effect<MobileDevice, MobileDevicePersistenceError>
	readonly unregister: (
		orgId: OrgId,
		userId: UserId,
		platform: MobilePlatform,
		token: string,
	) => Effect.Effect<MobileDevice, MobileDevicePersistenceError | MobileDeviceNotFoundError>
	readonly listForUser: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<ReadonlyArray<MobileDevice>, MobileDevicePersistenceError>
	/** One device by its push token, or null. */
	readonly find: (
		orgId: OrgId,
		platform: MobilePlatform,
		token: string,
	) => Effect.Effect<MobileDevice | null, MobileDevicePersistenceError>
	/** Enabled devices only — what the fan-out sends to. */
	readonly listForOrg: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<MobileDevice>, MobileDevicePersistenceError>
	/** The platform said the token is dead; stop sending until the app re-registers it. */
	readonly disable: (
		id: MobileDeviceId,
		reason: string,
	) => Effect.Effect<void, MobileDevicePersistenceError>
	readonly markPushed: (
		ids: ReadonlyArray<MobileDeviceId>,
	) => Effect.Effect<void, MobileDevicePersistenceError>
}

const makePersistenceError = makePersistenceErrorMapper(
	MobileDevicePersistenceError,
	"Mobile device persistence failed",
)

const decodeMobileDeviceId = Schema.decodeUnknownSync(MobileDeviceId)
const decodePlatform = Schema.decodeUnknownSync(Schema.Literals(["ios"]))
const decodeEnvironment = Schema.decodeUnknownSync(Schema.Literals(["sandbox", "production"]))

const toDevice = (row: MobileDeviceRow): MobileDevice => ({
	id: decodeMobileDeviceId(row.id),
	orgId: row.orgId,
	userId: row.userId,
	platform: decodePlatform(row.platform),
	token: row.token,
	environment: decodeEnvironment(row.environment),
	bundleId: row.bundleId,
	appVersion: row.appVersion,
	deviceName: row.deviceName,
	liveActivityStartToken: row.liveActivityStartToken,
	preferences: resolveMobileDevicePreferences(row.preferences),
	enabled: row.disabledAt === null,
	lastSeenAtMs: dateToMs(row.lastSeenAt),
	createdAtMs: dateToMs(row.createdAt),
})

export class MobileDevicesService extends Context.Service<MobileDevicesService, MobileDevicesServiceApi>()(
	"@maple/api/services/push/MobileDevicesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "MobileDevicesService", makePersistenceError)

			const findRow = (orgId: OrgId, platform: MobilePlatform, token: string) =>
				dbExecute((db) =>
					db
						.select()
						.from(mobileDevices)
						.where(
							and(
								eq(mobileDevices.orgId, orgId),
								eq(mobileDevices.platform, platform),
								eq(mobileDevices.token, token),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			const register = Effect.fn("MobileDevicesService.register")(function* (
				orgId: OrgId,
				userId: UserId,
				input: RegisterMobileDeviceInput,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.push.platform": input.platform,
				})
				const nowMs = yield* Clock.currentTimeMillis
				const now = msToDate(nowMs)
				const existing = yield* findRow(orgId, input.platform, input.token)

				// Preferences merge over what is stored so a settings toggle can
				// send just the key it changed; the row keeps sparse storage so a
				// future default applies to devices that never expressed a choice.
				const storedPreferences = existing?.preferences ?? {}
				const preferences = {
					...storedPreferences,
					...(input.preferences?.criticalIncidents !== undefined
						? { criticalIncidents: input.preferences.criticalIncidents }
						: undefined),
					...(input.preferences?.warningIncidents !== undefined
						? { warningIncidents: input.preferences.warningIncidents }
						: undefined),
					...(input.preferences?.resolvedIncidents !== undefined
						? { resolvedIncidents: input.preferences.resolvedIncidents }
						: undefined),
					...(input.preferences?.newErrorIssues !== undefined
						? { newErrorIssues: input.preferences.newErrorIssues }
						: undefined),
					...(input.preferences?.anomalies !== undefined
						? { anomalies: input.preferences.anomalies }
						: undefined),
				}

				if (existing) {
					const rows = yield* dbExecute((db) =>
						db
							.update(mobileDevices)
							.set({
								// A token can move between users when a shared phone
								// signs in as someone else — the latest sign-in owns it.
								userId,
								environment: input.environment,
								bundleId: input.bundleId,
								appVersion: input.appVersion ?? existing.appVersion,
								deviceName: input.deviceName ?? existing.deviceName,
								liveActivityStartToken:
									input.liveActivityStartToken ?? existing.liveActivityStartToken,
								preferences,
								disabledAt: null,
								disabledReason: null,
								lastSeenAt: now,
								updatedAt: now,
							})
							.where(eq(mobileDevices.id, existing.id))
							.returning(),
					)
					return toDevice(rows[0] ?? existing)
				}

				const rows = yield* dbExecute((db) =>
					db
						.insert(mobileDevices)
						.values({
							id: randomUUID(),
							orgId,
							userId,
							platform: input.platform,
							token: input.token,
							environment: input.environment,
							bundleId: input.bundleId,
							appVersion: input.appVersion ?? null,
							deviceName: input.deviceName ?? null,
							liveActivityStartToken: input.liveActivityStartToken ?? null,
							preferences,
							disabledAt: null,
							disabledReason: null,
							lastPushedAt: null,
							lastSeenAt: now,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				)
				return toDevice(rows[0]!)
			})

			const unregister = Effect.fn("MobileDevicesService.unregister")(function* (
				orgId: OrgId,
				userId: UserId,
				platform: MobilePlatform,
				token: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const rows = yield* dbExecute((db) =>
					db
						.delete(mobileDevices)
						.where(
							and(
								eq(mobileDevices.orgId, orgId),
								eq(mobileDevices.userId, userId),
								eq(mobileDevices.platform, platform),
								eq(mobileDevices.token, token),
							),
						)
						.returning(),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new MobileDeviceNotFoundError({ message: "Device not registered", token })
				}
				return toDevice(row)
			})

			const find = Effect.fn("MobileDevicesService.find")(function* (
				orgId: OrgId,
				platform: MobilePlatform,
				token: string,
			) {
				const row = yield* findRow(orgId, platform, token)
				return row === null ? null : toDevice(row)
			})

			const listForUser = Effect.fn("MobileDevicesService.listForUser")(function* (
				orgId: OrgId,
				userId: UserId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(mobileDevices)
						.where(and(eq(mobileDevices.orgId, orgId), eq(mobileDevices.userId, userId))),
				)
				return rows.map(toDevice)
			})

			const listForOrg = Effect.fn("MobileDevicesService.listForOrg")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(mobileDevices)
						.where(and(eq(mobileDevices.orgId, orgId), isNull(mobileDevices.disabledAt))),
				)
				return rows.map(toDevice)
			})

			const disable = Effect.fn("MobileDevicesService.disable")(function* (
				id: MobileDeviceId,
				reason: string,
			) {
				const now = msToDate(yield* Clock.currentTimeMillis)
				yield* dbExecute((db) =>
					db
						.update(mobileDevices)
						.set({ disabledAt: now, disabledReason: reason, updatedAt: now })
						.where(eq(mobileDevices.id, id)),
				)
			})

			const markPushed = Effect.fn("MobileDevicesService.markPushed")(function* (
				ids: ReadonlyArray<MobileDeviceId>,
			) {
				if (ids.length === 0) return
				const now = msToDate(yield* Clock.currentTimeMillis)
				yield* Effect.forEach(
					ids,
					(id) =>
						dbExecute((db) =>
							db
								.update(mobileDevices)
								.set({ lastPushedAt: now })
								.where(eq(mobileDevices.id, id)),
						),
					{ discard: true },
				)
			})

			return {
				register,
				unregister,
				find,
				listForUser,
				listForOrg,
				disable,
				markPushed,
			} satisfies MobileDevicesServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
