import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	MobileDeviceNotFoundError,
	MobileDevicePersistenceError,
	MobileDevicePreferences,
	MobilePlatform,
	MobilePushEnvironment,
} from "../mobile-devices"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, Timestamp } from "./envelopes"
import { publicError } from "./public-error"
import { AlertIncidentPublicId, MobileDevicePublicId } from "./resource-ids"

const DeviceToken = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(512)).annotate({
	title: "Device token",
	description: "The platform push token — the hex APNs device token on iOS. Opaque to Maple.",
	examples: ["a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"],
})

const LiveActivityStartToken = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(512)).annotate({
	title: "Live Activity push-to-start token",
	description:
		"ActivityKit's push-to-start token, hex. Lets Maple start a Lock Screen Live Activity for a critical incident on a phone that has not opened the app. Opaque to Maple.",
})

const preferencesField = MobileDevicePreferences.annotate({
	description:
		"Which events this device is pushed. Omitted keys keep their default: `critical_incidents` defaults to `true`, and every other key to `false`.",
	examples: [{ critical_incidents: true, warning_incidents: true, resolved_incidents: false }],
})

const mobileDeviceExample = {
	id: "mdev_YofPTrK9782DWwcnXhpcCw",
	object: "mobile_device",
	platform: "ios",
	token: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
	environment: "production",
	bundle_id: "com.maple.mobile",
	app_version: "0.2.0",
	device_name: "iPhone",
	preferences: {
		critical_incidents: true,
		warning_incidents: false,
		resolved_incidents: false,
		new_error_issues: false,
		anomalies: false,
	},
	live_activities_enabled: true,
	enabled: true,
	last_seen_at: "2026-08-17T09:10:00.000Z",
	created_at: "2026-08-01T12:00:00.000Z",
} as const

export const V2MobileDevice = Schema.Struct({
	id: MobileDevicePublicId,
	object: Schema.Literal("mobile_device").annotate({
		description: 'The object type — always `"mobile_device"`.',
	}),
	platform: MobilePlatform,
	token: DeviceToken,
	environment: MobilePushEnvironment.annotate({
		description: "`sandbox` for development builds, `production` for TestFlight and App Store builds.",
	}),
	bundle_id: Schema.String,
	app_version: Schema.NullOr(Schema.String),
	device_name: Schema.NullOr(Schema.String),
	/** Fully resolved — every key present. */
	preferences: Schema.Struct({
		critical_incidents: Schema.Boolean,
		warning_incidents: Schema.Boolean,
		resolved_incidents: Schema.Boolean,
		new_error_issues: Schema.Boolean,
		anomalies: Schema.Boolean,
	}),
	live_activities_enabled: Schema.Boolean.annotate({
		description:
			"`true` once the device has handed over a Live Activity push-to-start token, meaning critical incidents can raise a Lock Screen Live Activity on it.",
	}),
	enabled: Schema.Boolean.annotate({
		description:
			"`false` once the platform reported the token dead. Re-registering the token re-enables the device.",
	}),
	last_seen_at: Timestamp,
	created_at: Timestamp,
}).annotate({
	identifier: "MobileDevice",
	title: "Mobile Device",
	description:
		"A phone registered for push notifications by the current user in the current organization. Alert incidents fan out to every enabled device whose preferences include the event.",
	examples: [wireExample(mobileDeviceExample)],
})
export type V2MobileDevice = Schema.Schema.Type<typeof V2MobileDevice>

export const V2MobileDeviceRegisterParams = Schema.Struct({
	platform: MobilePlatform,
	environment: MobilePushEnvironment,
	bundle_id: Schema.String.check(Schema.isMinLength(1)).annotate({ examples: ["com.maple.mobile"] }),
	app_version: Schema.optionalKey(Schema.String),
	device_name: Schema.optionalKey(Schema.String),
	preferences: Schema.optionalKey(preferencesField),
	live_activity_start_token: Schema.optionalKey(LiveActivityStartToken),
}).annotate({
	identifier: "MobileDeviceRegisterParams",
	title: "Mobile device registration",
	description:
		"Registers or refreshes a device. Idempotent on `(platform, token)` within the organization: the app calls this on every launch and whenever the token or preferences change.",
})
export type V2MobileDeviceRegisterParams = Schema.Schema.Type<typeof V2MobileDeviceRegisterParams>

export const V2MobileDeviceDeleteResponse = Schema.Struct({
	id: MobileDevicePublicId,
	object: Schema.Literal("mobile_device"),
	deleted: Schema.Literal(true),
}).annotate({ identifier: "MobileDeviceDeleteResponse", title: "Mobile device delete response" })

const liveActivityExample = {
	object: "live_activity",
	incident_id: "inc_YofPTrK9782DWwcnXhpcCw",
	activity_id: "F9E1B4C0-8F2A-4C6D-9E1B-4C08F2A4C6D9",
	ended: false,
	created_at: "2026-08-17T09:10:00.000Z",
} as const

export const V2LiveActivity = Schema.Struct({
	object: Schema.Literal("live_activity").annotate({
		description: 'The object type — always `"live_activity"`.',
	}),
	incident_id: AlertIncidentPublicId,
	activity_id: Schema.String,
	ended: Schema.Boolean,
	created_at: Timestamp,
}).annotate({
	identifier: "LiveActivity",
	title: "Live Activity",
	description:
		"A Lock Screen Live Activity running on one device for one alert incident. Maple pushes updates to it as the incident renotifies, and ends it when the incident resolves.",
	examples: [wireExample(liveActivityExample)],
})
export type V2LiveActivity = Schema.Schema.Type<typeof V2LiveActivity>

export const V2LiveActivityRegisterParams = Schema.Struct({
	activity_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
		description: "ActivityKit's own identifier for the running activity.",
	}),
	push_token: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(512)).annotate({
		description:
			"The activity's APNs update token, hex. Different from both the device token and the push-to-start token, and rotated by iOS — the app re-submits it on every rotation.",
	}),
}).annotate({
	identifier: "LiveActivityRegisterParams",
	title: "Live Activity registration",
	description:
		"Hands Maple the update token for an activity the device just started. Idempotent on `(device, incident)`.",
})
export type V2LiveActivityRegisterParams = Schema.Schema.Type<typeof V2LiveActivityRegisterParams>

export const V2LiveActivityDeleteResponse = Schema.Struct({
	object: Schema.Literal("live_activity"),
	incident_id: AlertIncidentPublicId,
	deleted: Schema.Literal(true),
}).annotate({ identifier: "LiveActivityDeleteResponse", title: "Live Activity delete response" })

const persistence = publicError(MobileDevicePersistenceError)
const notFound = publicError(MobileDeviceNotFoundError)

const MobileDeviceList = ListOf(V2MobileDevice).annotate({
	identifier: "MobileDeviceList",
	title: "Mobile device list",
})

export class V2MobileDevicesApiGroup extends HttpApiGroup.make("mobileDevices")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: MobileDeviceList,
			error: [persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listMobileDevices",
				summary: "List my devices",
				description:
					"Returns the devices the current user has registered in the current organization. Requires the `mobile_devices:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("register", "/:token", {
			params: { token: DeviceToken },
			payload: V2MobileDeviceRegisterParams,
			success: V2MobileDevice,
			error: [persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "registerMobileDevice",
				summary: "Register or refresh a device",
				description:
					"Upserts the device identified by its push token for the current user and organization, re-enabling it if the platform had marked it dead. Requires the `mobile_devices:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("unregister", "/:token", {
			params: { token: DeviceToken },
			success: V2MobileDeviceDeleteResponse,
			error: [notFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "unregisterMobileDevice",
				summary: "Unregister a device",
				description:
					"Removes the device from the current organization; the app calls this on sign-out. Requires the `mobile_devices:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("registerLiveActivity", "/:token/live_activities/:incident_id", {
			params: { token: DeviceToken, incident_id: AlertIncidentPublicId },
			payload: V2LiveActivityRegisterParams,
			success: V2LiveActivity,
			error: [notFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "registerLiveActivity",
				summary: "Register a Live Activity update token",
				description:
					"Records the APNs update token for a Live Activity the device started for this incident, so Maple can update and end it. Requires the `mobile_devices:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("endLiveActivity", "/:token/live_activities/:incident_id", {
			params: { token: DeviceToken, incident_id: AlertIncidentPublicId },
			success: V2LiveActivityDeleteResponse,
			error: [notFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "endLiveActivity",
				summary: "Forget a Live Activity",
				description:
					"Called when the activity ended on the device — dismissed by the user or ended by the app — so Maple stops pushing to a dead token. Requires the `mobile_devices:write` scope.",
			}),
		),
	)
	.prefix("/v2/mobile_devices")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Mobile Devices",
			description: "Push-notification registrations for the native apps. Per user, per organization.",
		}),
	) {}
