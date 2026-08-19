import { randomUUID } from "node:crypto"
import { liveActivities, type LiveActivityRow } from "@maple/db"
import { MobileDevicePersistenceError } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { and, eq, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import { dateToMs, msToDate } from "@/platform/time"

/**
 * The Lock Screen Live Activities Maple has running for open incidents.
 *
 * A Live Activity needs two different APNs tokens: the device's push-to-start
 * token creates it (that one lives on `mobile_devices`), and a per-activity
 * token — only knowable once the activity exists, and only by the app — updates
 * and ends it. This service owns the second kind: the app PUTs it after the
 * activity starts, the incident fan-out reads it on renotify and resolve.
 */

export interface LiveActivity {
	readonly id: string
	readonly orgId: OrgId
	/**
	 * Plain strings, not the branded ids, on purpose: both a branded
	 * `MobileDeviceId`/`AlertIncidentId` and the raw internal id the alert
	 * fan-out carries are assignable here, so no call site has to cast.
	 */
	readonly deviceId: string
	readonly incidentId: string
	readonly activityId: string
	readonly pushToken: string
	readonly endedAtMs: number | null
	readonly createdAtMs: number
}

export interface LiveActivitiesServiceApi {
	/** Upsert on (device, incident): iOS rotates the token and the app re-submits it. */
	readonly register: (input: {
		readonly orgId: OrgId
		readonly deviceId: string
		readonly incidentId: string
		readonly activityId: string
		readonly pushToken: string
	}) => Effect.Effect<LiveActivity, MobileDevicePersistenceError>
	/** The activities still running for an incident — what an update or end push goes to. */
	readonly listActive: (
		orgId: OrgId,
		incidentId: string,
	) => Effect.Effect<ReadonlyArray<LiveActivity>, MobileDevicePersistenceError>
	readonly end: (id: string, reason: string) => Effect.Effect<void, MobileDevicePersistenceError>
	/** The app says this one is gone (dismissed, or ended locally). */
	readonly endForDevice: (
		orgId: OrgId,
		deviceId: string,
		incidentId: string,
		reason: string,
	) => Effect.Effect<LiveActivity | null, MobileDevicePersistenceError>
}

const makePersistenceError = makePersistenceErrorMapper(
	MobileDevicePersistenceError,
	"Live activity persistence failed",
)

const toLiveActivity = (row: LiveActivityRow): LiveActivity => ({
	id: row.id,
	orgId: row.orgId,
	deviceId: row.deviceId,
	incidentId: row.incidentId,
	activityId: row.activityId,
	pushToken: row.pushToken,
	endedAtMs: row.endedAt === null ? null : dateToMs(row.endedAt),
	createdAtMs: dateToMs(row.createdAt),
})

export class LiveActivitiesService extends Context.Service<LiveActivitiesService, LiveActivitiesServiceApi>()(
	"@maple/api/services/push/LiveActivitiesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "LiveActivitiesService", makePersistenceError)

			const register = Effect.fn("LiveActivitiesService.register")(function* (input: {
				readonly orgId: OrgId
				readonly deviceId: string
				readonly incidentId: string
				readonly activityId: string
				readonly pushToken: string
			}) {
				yield* Effect.annotateCurrentSpan({
					orgId: input.orgId,
					"maple.alert.incident_id": input.incidentId,
				})
				const now = msToDate(yield* Clock.currentTimeMillis)
				const rows = yield* dbExecute((db) =>
					db
						.insert(liveActivities)
						.values({
							id: randomUUID(),
							orgId: input.orgId,
							deviceId: input.deviceId,
							incidentId: input.incidentId,
							activityId: input.activityId,
							pushToken: input.pushToken,
							endedAt: null,
							endedReason: null,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [liveActivities.deviceId, liveActivities.incidentId],
							set: {
								activityId: input.activityId,
								pushToken: input.pushToken,
								// A re-registration is the app telling us an activity is
								// running again — a previously ended row comes back to life
								// rather than leaving the phone stuck on stale content.
								endedAt: null,
								endedReason: null,
								updatedAt: now,
							},
						})
						.returning(),
				)
				return toLiveActivity(rows[0]!)
			})

			const listActive = Effect.fn("LiveActivitiesService.listActive")(function* (
				orgId: OrgId,
				incidentId: string,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(liveActivities)
						.where(
							and(
								eq(liveActivities.orgId, orgId),
								eq(liveActivities.incidentId, incidentId),
								isNull(liveActivities.endedAt),
							),
						),
				)
				return rows.map(toLiveActivity)
			})

			const end = Effect.fn("LiveActivitiesService.end")(function* (id: string, reason: string) {
				const now = msToDate(yield* Clock.currentTimeMillis)
				yield* dbExecute((db) =>
					db
						.update(liveActivities)
						.set({ endedAt: now, endedReason: reason, updatedAt: now })
						.where(and(eq(liveActivities.id, id), isNull(liveActivities.endedAt))),
				)
			})

			const endForDevice = Effect.fn("LiveActivitiesService.endForDevice")(function* (
				orgId: OrgId,
				deviceId: string,
				incidentId: string,
				reason: string,
			) {
				const now = msToDate(yield* Clock.currentTimeMillis)
				const rows = yield* dbExecute((db) =>
					db
						.update(liveActivities)
						.set({ endedAt: now, endedReason: reason, updatedAt: now })
						.where(
							and(
								eq(liveActivities.orgId, orgId),
								eq(liveActivities.deviceId, deviceId),
								eq(liveActivities.incidentId, incidentId),
							),
						)
						.returning(),
				)
				const row = rows[0]
				return row === undefined ? null : toLiveActivity(row)
			})

			return { register, listActive, end, endForDevice } satisfies LiveActivitiesServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
