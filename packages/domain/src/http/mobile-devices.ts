import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

/**
 * Push notifications for the native apps.
 *
 * A phone is registered per (organization, user); the alert scheduler fans out
 * to every enabled device in the org whose preferences include the event. This
 * is deliberately not an alert destination — see the note on `mobile_devices`
 * in `@maple/db`.
 */

export const MobilePlatform = Schema.Literals(["ios"]).annotate({
	identifier: "@maple/MobilePlatform",
	title: "Mobile Platform",
})
export type MobilePlatform = Schema.Schema.Type<typeof MobilePlatform>

/** Which APNs host the token belongs to. Development builds get sandbox tokens. */
export const MobilePushEnvironment = Schema.Literals(["sandbox", "production"]).annotate({
	identifier: "@maple/MobilePushEnvironment",
	title: "Mobile Push Environment",
})
export type MobilePushEnvironment = Schema.Schema.Type<typeof MobilePushEnvironment>

/**
 * What a device wants to hear about. Every key is optional on the wire and in
 * storage so an app build that predates a key keeps its default; the resolved
 * form is `resolveMobileDevicePreferences`.
 */
export const MobileDevicePreferences = Schema.Struct({
	critical_incidents: Schema.optionalKey(Schema.Boolean),
	warning_incidents: Schema.optionalKey(Schema.Boolean),
	resolved_incidents: Schema.optionalKey(Schema.Boolean),
	new_error_issues: Schema.optionalKey(Schema.Boolean),
	anomalies: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "@maple/MobileDevicePreferences",
	title: "Mobile Device Preferences",
})
export type MobileDevicePreferences = Schema.Schema.Type<typeof MobileDevicePreferences>

export interface ResolvedMobileDevicePreferences {
	readonly criticalIncidents: boolean
	readonly warningIncidents: boolean
	readonly resolvedIncidents: boolean
	readonly newErrorIssues: boolean
	readonly anomalies: boolean
}

/**
 * **Only critical incidents by default.** Everything else — warnings,
 * resolutions, issues, anomalies — is opt-in.
 *
 * A phone is not a dashboard. The default has to be the set of events worth
 * interrupting someone for wherever they are, and that is exactly one of them;
 * anyone who wants the rest can say so in Settings, whereas someone buried in
 * warnings turns the whole thing off and loses the criticals too.
 */
export const resolveMobileDevicePreferences = (
	stored:
		| {
				readonly criticalIncidents?: boolean
				readonly warningIncidents?: boolean
				readonly resolvedIncidents?: boolean
				readonly newErrorIssues?: boolean
				readonly anomalies?: boolean
		  }
		| null
		| undefined,
): ResolvedMobileDevicePreferences => ({
	criticalIncidents: stored?.criticalIncidents ?? true,
	warningIncidents: stored?.warningIncidents ?? false,
	resolvedIncidents: stored?.resolvedIncidents ?? false,
	newErrorIssues: stored?.newErrorIssues ?? false,
	anomalies: stored?.anomalies ?? false,
})

export class MobileDevicePersistenceError extends HttpTaggedError<MobileDevicePersistenceError>()(
	"@maple/http/errors/MobileDevicePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "mobile_devices_unavailable",
		title: "Device registration is temporarily unavailable",
		message: "Device registration is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class MobileDeviceNotFoundError extends HttpTaggedError<MobileDeviceNotFoundError>()(
	"@maple/http/errors/MobileDeviceNotFoundError",
	{
		message: Schema.String,
		token: Schema.String,
	},
	{
		status: 404,
		code: "mobile_device_not_found",
		title: "Device not registered",
		message: "No device with this token is registered for the current user.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
