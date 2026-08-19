import type {
	AlertComparator,
	AlertEventType,
	AlertSeverity,
	AlertSignalType,
	OrgId,
} from "@maple/domain/http"
import { PublicIdPrefixes, encodePublicId } from "@maple/domain/http/v2"
import { Context, Duration, Effect, Layer } from "effect"
import { ApnsClient, type ApnsPush } from "@/platform/Apns"
import {
	displayGroupKey,
	formatObservedSummary,
	formatSignalMetric,
	formatWindow,
	truncate,
} from "@/services/alerts/alert-formatting"
import type { SignalDisplay } from "@/services/alerts/alert-signal-display"
import { MobileDevicesService, type MobileDevice } from "./MobileDevicesService"

/**
 * Fans an alert event out to the phones registered in the organization.
 *
 * Independent of the rule's destinations on purpose: a rule with no Slack
 * channel still reaches the people who installed the app, and a person's
 * phone follows them rather than the rule. Best-effort — every failure is a
 * log line and a metric, never an error on the scheduler tick that produced
 * the event.
 */

export interface IncidentPushEvent {
	readonly orgId: OrgId
	readonly eventType: AlertEventType
	readonly incidentId: string
	readonly ruleId: string
	readonly ruleName: string
	readonly severity: AlertSeverity
	readonly signalType: AlertSignalType
	readonly signalDisplay: SignalDisplay
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly value: number | null
	readonly groupKey: string | null
	readonly serviceNames: ReadonlyArray<string>
	readonly windowMinutes: number
	readonly dedupeKey: string
	/** Milliseconds the incident had been open when it resolved; null while open. */
	readonly openForMs: number | null
	readonly linkUrl: string
}

export interface MobilePushSummary {
	readonly sent: number
	readonly failed: number
	readonly unregistered: number
	readonly skipped: number
}

export interface MobilePushServiceApi {
	readonly notifyIncident: (event: IncidentPushEvent) => Effect.Effect<MobilePushSummary>
}

const SEND_CONCURRENCY = 8
const SEND_TIMEOUT = Duration.seconds(8)

const wantsEvent = (device: MobileDevice, event: IncidentPushEvent): boolean => {
	switch (event.eventType) {
		case "resolve":
			return device.preferences.resolvedIncidents
		case "trigger":
		case "renotify":
			return event.severity === "critical"
				? device.preferences.criticalIncidents
				: device.preferences.warningIncidents
		case "test":
			return false
	}
}

const humanDuration = (ms: number): string => {
	const minutes = Math.max(1, Math.round(ms / 60_000))
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
	const days = Math.floor(hours / 24)
	return `${days}d ${hours % 24}h`
}

/**
 * The card on the phone: rule name up top, severity + service as the
 * subtitle, and the breach in the signal's unit as the body — the same three
 * lines Home shows, so the notification and the screen it opens agree.
 */
export const renderIncidentPush = (
	event: IncidentPushEvent,
): Pick<ApnsPush, "alert" | "interruptionLevel" | "priority"> => {
	const service =
		displayGroupKey(event.groupKey) ??
		(event.serviceNames.length === 1
			? event.serviceNames[0]
			: event.serviceNames.length > 1
				? `${event.serviceNames[0]} +${event.serviceNames.length - 1}`
				: null)
	const severity = event.severity === "critical" ? "Critical" : "Warning"
	const observed = formatObservedSummary({
		signalType: event.signalType,
		signalDisplay: event.signalDisplay,
		value: event.value,
		comparator: event.comparator,
		threshold: event.threshold,
		thresholdUpper: event.thresholdUpper,
	})
	const label = event.signalDisplay.label

	switch (event.eventType) {
		case "resolve": {
			const now = formatSignalMetric(event.value, event.signalDisplay)
			const after = event.openForMs === null ? "" : ` after ${humanDuration(event.openForMs)}`
			return {
				alert: {
					title: `Resolved: ${truncate(event.ruleName, 60)}`,
					subtitle: service ?? undefined,
					body: `${label} back to ${now}${after}.`,
				},
				interruptionLevel: "passive",
				priority: 5,
			}
		}
		case "renotify":
			return {
				alert: {
					title: truncate(event.ruleName, 60),
					subtitle: `Still ${severity.toLowerCase()}${service ? ` · ${service}` : ""}`,
					body: `${label} ${observed} over ${formatWindow(event.windowMinutes)}.`,
				},
				interruptionLevel: "active",
				priority: 10,
			}
		case "trigger":
		case "test":
			return {
				alert: {
					title: truncate(event.ruleName, 60),
					subtitle: `${severity}${service ? ` · ${service}` : ""}`,
					body: `${label} ${observed} over ${formatWindow(event.windowMinutes)}.`,
				},
				interruptionLevel: event.severity === "critical" ? "time-sensitive" : "active",
				priority: 10,
			}
	}
}

export class MobilePushService extends Context.Service<MobilePushService, MobilePushServiceApi>()(
	"@maple/api/services/push/MobilePushService",
	{
		make: Effect.gen(function* () {
			const apns = yield* ApnsClient
			const devices = yield* MobileDevicesService

			const notifyIncident = Effect.fn("MobilePushService.notifyIncident")(function* (
				event: IncidentPushEvent,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: event.orgId,
					"maple.alert.rule_id": event.ruleId,
					"maple.alert.incident_id": event.incidentId,
					"event.type": event.eventType,
				})
				const empty: MobilePushSummary = { sent: 0, failed: 0, unregistered: 0, skipped: 0 }

				// Not configured is the normal state for self-hosted and for every
				// stage without Apple credentials — quiet, not a warning.
				if (!apns.isConfigured) return empty

				const registered = yield* devices
					.listForOrg(event.orgId)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("Mobile push: could not list devices").pipe(
								Effect.annotateLogs({ orgId: event.orgId, error: error.message }),
								Effect.as([] as ReadonlyArray<MobileDevice>),
							),
						),
					)
				const targets = registered.filter((device) => wantsEvent(device, event))
				const skipped = registered.length - targets.length
				if (targets.length === 0) return { ...empty, skipped }

				const rendered = renderIncidentPush(event)
				const results = yield* Effect.forEach(
					targets,
					(device) =>
						apns
							.send({
								deviceToken: device.token,
								environment: device.environment,
								bundleId: device.bundleId,
								alert: rendered.alert,
								interruptionLevel: rendered.interruptionLevel,
								priority: rendered.priority,
								// One incident stream = one notification on the device;
								// a renotify or resolve replaces the trigger.
								collapseId: event.dedupeKey,
								threadId: event.ruleId,
								data: {
									maple_kind: "alert_incident",
									maple_event: event.eventType,
									// The phone hands this straight back to `GET
									// /v2/alerts/incidents/{id}`, which only accepts the
									// `inc_…` public form — the internal id 400s and the
									// tapped notification lands on an error screen.
									maple_incident_id: encodePublicId(
										PublicIdPrefixes.alertIncident,
										event.incidentId,
									),
									maple_rule_id: encodePublicId(PublicIdPrefixes.alertRule, event.ruleId),
									maple_org_id: event.orgId,
									maple_url: event.linkUrl,
								},
							})
							.pipe(
								Effect.timeout(SEND_TIMEOUT),
								Effect.map((result) => ({ device, result })),
								Effect.catch((error) =>
									Effect.succeed({
										device,
										result: {
											outcome: "failed" as const,
											status: 0,
											reason: error._tag === "TimeoutError" ? "timeout" : error.message,
											retryable: true,
										},
									}),
								),
							),
					{ concurrency: SEND_CONCURRENCY },
				)

				let sent = 0
				let failed = 0
				let unregistered = 0
				const pushed: Array<MobileDevice["id"]> = []
				for (const { device, result } of results) {
					switch (result.outcome) {
						case "sent":
							sent += 1
							pushed.push(device.id)
							break
						case "unregistered":
							unregistered += 1
							// Loud on purpose: a disabled row is silence on the phone until
							// the app re-registers, and the reason names the fix
							// (`BadDeviceToken` = wrong environment for the token,
							// `DeviceTokenNotForTopic` = a build signed for another app id).
							yield* Effect.logWarning(
								"Mobile push: Apple says the token is dead, disabling device",
							).pipe(
								Effect.annotateLogs({
									orgId: event.orgId,
									deviceId: device.id,
									environment: device.environment,
									bundleId: device.bundleId,
									appVersion: device.appVersion ?? "",
									reason: result.reason,
								}),
							)
							yield* devices.disable(device.id, result.reason).pipe(Effect.ignore)
							break
						case "failed":
							failed += 1
							yield* Effect.logWarning("Mobile push: APNs rejected the send").pipe(
								Effect.annotateLogs({
									orgId: event.orgId,
									deviceId: device.id,
									status: result.status,
									reason: result.reason,
									retryable: result.retryable,
								}),
							)
							break
					}
				}
				yield* devices.markPushed(pushed).pipe(Effect.ignore)
				yield* Effect.annotateCurrentSpan({
					"maple.push.sent": sent,
					"maple.push.failed": failed,
					"maple.push.unregistered": unregistered,
				})
				return { sent, failed, unregistered, skipped }
			})

			return { notifyIncident } satisfies MobilePushServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
