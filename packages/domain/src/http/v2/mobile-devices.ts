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
import { MobileDevicePublicId } from "./resource-ids"

const DeviceToken = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(512)).annotate({
	title: "Device token",
	description: "The platform push token — the hex APNs device token on iOS. Opaque to Maple.",
	examples: ["a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"],
})

const preferencesField = MobileDevicePreferences.annotate({
	description:
		"Which events this device is pushed. Omitted keys keep their default: `critical_incidents`, `warning_incidents`, and `resolved_incidents` default to `true`; `new_error_issues` and `anomalies` to `false`.",
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
		warning_incidents: true,
		resolved_incidents: true,
		new_error_issues: false,
		anomalies: false,
	},
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
	.prefix("/v2/mobile_devices")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Mobile Devices",
			description: "Push-notification registrations for the native apps. Per user, per organization.",
		}),
	) {}
