import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import type { V2MobileDevice } from "@maple/domain/http/v2"
import { MapleApiV2, isoTimestamp } from "@maple/domain/http/v2"
import { Effect } from "effect"
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
	enabled: device.enabled,
	last_seen_at: isoTimestamp(device.lastSeenAtMs),
	created_at: isoTimestamp(device.createdAtMs),
})

export const HttpV2MobileDevicesLive = HttpApiBuilder.group(MapleApiV2, "mobileDevices", (handlers) =>
	Effect.gen(function* () {
		const devices = yield* MobileDevicesService

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
