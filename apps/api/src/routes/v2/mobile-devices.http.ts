import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MobileDeviceNotFoundError } from "@maple/domain/http"
import type { V2MobileDevice } from "@maple/domain/http/v2"
import { MapleApiV2, isoTimestamp } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService, type MobileDevice } from "@/services/push/MobileDevicesService"

const toV2 = (device: MobileDevice): V2MobileDevice => ({
	id: device.id,
	object: "mobile_device",
	platform: device.platform,
	token: device.token,
	environment: device.environment,
	bundle_id: device.bundleId,
	app_version: device.appVersion,
	device_name: device.deviceName,
	preferences: {
		critical_incidents: device.preferences.criticalIncidents,
		warning_incidents: device.preferences.warningIncidents,
		resolved_incidents: device.preferences.resolvedIncidents,
		new_error_issues: device.preferences.newErrorIssues,
		anomalies: device.preferences.anomalies,
	},
	live_activities_enabled: device.liveActivityStartToken !== null,
	enabled: device.enabled,
	last_seen_at: isoTimestamp(device.lastSeenAtMs),
	created_at: isoTimestamp(device.createdAtMs),
})

export const HttpV2MobileDevicesLive = HttpApiBuilder.group(MapleApiV2, "mobileDevices", (handlers) =>
	Effect.gen(function* () {
		const devices = yield* MobileDevicesService
		const activities = yield* LiveActivitiesService

		/** The device the credential belongs to, or a 404 rather than a key. */
		const requireDevice = Effect.fn("HttpV2MobileDevices.requireDevice")(function* (
			orgId: CurrentTenant.TenantSchema["orgId"],
			token: string,
		) {
			const device = yield* devices.find(orgId, "ios", token)
			if (device === null) {
				return yield* new MobileDeviceNotFoundError({
					message: "Device not registered",
					token,
				})
			}
			return device
		})

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* devices.listForUser(tenant.orgId, tenant.userId)
					return {
						object: "list" as const,
						data: rows.map(toV2),
						has_more: false,
						next_cursor: null,
					}
				}),
			)
			.handle("register", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const device = yield* devices.register(tenant.orgId, tenant.userId, {
						platform: payload.platform,
						token: params.token,
						environment: payload.environment,
						bundleId: payload.bundle_id,
						appVersion: payload.app_version,
						deviceName: payload.device_name,
						liveActivityStartToken: payload.live_activity_start_token,
						preferences:
							payload.preferences === undefined
								? undefined
								: {
										criticalIncidents: payload.preferences.critical_incidents,
										warningIncidents: payload.preferences.warning_incidents,
										resolvedIncidents: payload.preferences.resolved_incidents,
										newErrorIssues: payload.preferences.new_error_issues,
										anomalies: payload.preferences.anomalies,
									},
					})
					return toV2(device)
				}),
			)
			.handle("registerLiveActivity", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// The activity belongs to a device, and the device is what says
					// which APNs host its tokens live on — an activity whose device is
					// gone could never be pushed to.
					const device = yield* requireDevice(tenant.orgId, params.token)
					const activity = yield* activities.register({
						orgId: tenant.orgId,
						deviceId: device.id,
						incidentId: params.incident_id,
						activityId: payload.activity_id,
						pushToken: payload.push_token,
					})
					return {
						object: "live_activity" as const,
						// The path param is already the decoded internal id; the success
						// schema re-encodes it to `inc_…` on the way out.
						incident_id: params.incident_id,
						activity_id: activity.activityId,
						ended: activity.endedAtMs !== null,
						created_at: isoTimestamp(activity.createdAtMs),
					}
				}),
			)
			.handle("endLiveActivity", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const device = yield* requireDevice(tenant.orgId, params.token)
					yield* activities.endForDevice(
						tenant.orgId,
						device.id,
						params.incident_id,
						"ended_on_device",
					)
					// Idempotent: an activity the server never knew about is already
					// in the state the app is asking for.
					return {
						object: "live_activity" as const,
						incident_id: params.incident_id,
						deleted: true as const,
					}
				}),
			)
			.handle("unregister", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// One token, one platform for now; the path is platform-agnostic
					// so Android can join without a route change.
					const device = yield* devices.unregister(tenant.orgId, tenant.userId, "ios", params.token)
					return { id: device.id, object: "mobile_device" as const, deleted: true as const }
				}),
			)
	}),
)
