import type {
	AlertComparator,
	AlertEventType,
	AlertSeverity,
	AlertSignalType,
	OrgId,
} from "@maple/domain/http"
import { PublicIdPrefixes, encodePublicId } from "@maple/domain/http/v2"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { ApnsClient, type ApnsPush } from "@/platform/Apns"
import {
	displayGroupKey,
	formatObservedSummary,
	formatSignalMetric,
	formatThresholdSummary,
	formatWindow,
	truncate,
} from "@/services/alerts/alert-formatting"
import type { SignalDisplay } from "@/services/alerts/alert-signal-display"
import { LiveActivitiesService, type LiveActivity } from "./LiveActivitiesService"
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
	/**
	 * Recent observed values for this rule and group, newest first — the shape
	 * the Lock Screen sparkline draws.
	 *
	 * Deliberately an unevaluated Effect: reading it is a warehouse query, and
	 * only a critical incident on a phone that can run Live Activities ever uses
	 * it. Passing the values eagerly would bill that query for every incident in
	 * every org, almost always to throw the result away.
	 */
	readonly recentValues?: Effect.Effect<ReadonlyArray<number>> | undefined
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

/**
 * The `ActivityAttributes` type name in the iOS app. Apple matches the `start`
 * push to a declared activity by this exact string — rename the Swift type and
 * every start push silently does nothing.
 * See `IncidentActivityAttributes.swift`.
 */
const LIVE_ACTIVITY_ATTRIBUTES_TYPE = "IncidentActivityAttributes"

/**
 * How long a Live Activity's content is presented as current. Past it iOS dims
 * the numbers, which is the honest rendering: alert checks run on a schedule,
 * and a value nobody has refreshed in 20 minutes is not "now".
 */
const LIVE_ACTIVITY_STALE_SECONDS = 20 * 60

/** A resolved incident stays on the Lock Screen briefly, then clears itself. */
const LIVE_ACTIVITY_DISMISS_SECONDS = 5 * 60

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

/**
 * The Live Activity's static half: what the incident *is*, fixed for as long as
 * the activity runs. Keys are snake_case because ActivityKit decodes this
 * dictionary straight into the Swift `ActivityAttributes`, whose `CodingKeys`
 * spell them that way.
 *
 * Time is epoch **seconds as a number**, never an ISO string: ActivityKit
 * decodes with a plain `JSONDecoder`, whose default date strategy is Apple's
 * 2001 reference date — an ISO string fails to decode and the activity never
 * starts, with no error anywhere.
 */
export const renderLiveActivityAttributes = (
	event: IncidentPushEvent,
	nowMs: number,
): Record<string, unknown> => ({
	incident_id: encodePublicId(PublicIdPrefixes.alertIncident, event.incidentId),
	rule_name: truncate(event.ruleName, 60),
	service:
		displayGroupKey(event.groupKey) ??
		(event.serviceNames.length === 1
			? event.serviceNames[0]
			: event.serviceNames.length > 1
				? `${event.serviceNames[0]} +${event.serviceNames.length - 1}`
				: null),
	signal_label: event.signalDisplay.label,
	started_at: Math.floor((nowMs - (event.openForMs ?? 0)) / 1000),
})

/**
 * How many points the sparkline carries. Twelve is what reads at 40pt wide on a
 * Lock Screen — more becomes a texture rather than a trend — and keeps the
 * content state far inside ActivityKit's 4KB cap.
 */
const LIVE_ACTIVITY_SERIES_POINTS = 12

/**
 * The series the Lock Screen draws: recent checks oldest-first, with the
 * current value appended.
 *
 * The append is not decoration. `alert_checks` is written through the ingest
 * pipeline, so the check that just fired this notification is usually not
 * queryable yet — without it the chart would always lag one point behind the
 * number printed beside it.
 */
export const buildLiveActivitySeries = (
	event: IncidentPushEvent,
	recentValues: ReadonlyArray<number>,
): ReadonlyArray<number> => {
	const history = [...recentValues].reverse().filter((value) => Number.isFinite(value))
	const series = event.value === null ? history : [...history, event.value]
	return series.slice(-LIVE_ACTIVITY_SERIES_POINTS)
}

/** The Live Activity's moving half: the numbers, and whether it is still firing. */
export const renderLiveActivityState = (
	event: IncidentPushEvent,
	nowMs: number,
	series: ReadonlyArray<number> = [],
): Record<string, unknown> => ({
	value: formatSignalMetric(event.value, event.signalDisplay),
	threshold: formatThresholdSummary({
		signalType: event.signalType,
		signalDisplay: event.signalDisplay,
		comparator: event.comparator,
		threshold: event.threshold,
		thresholdUpper: event.thresholdUpper,
	}),
	status: event.eventType === "resolve" ? "resolved" : "firing",
	updated_at: Math.floor(nowMs / 1000),
	series,
	// The raw number, not the formatted string: the sparkline draws the
	// threshold as a dashed rule in the same units as the series.
	threshold_value: event.threshold,
})

export class MobilePushService extends Context.Service<MobilePushService, MobilePushServiceApi>()(
	"@maple/api/services/push/MobilePushService",
	{
		make: Effect.gen(function* () {
			const apns = yield* ApnsClient
			const devices = yield* MobileDevicesService
			const activities = yield* LiveActivitiesService

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
				if (targets.length === 0) {
					// Nobody wants the banner, but an activity already on someone's
					// Lock Screen still has to be updated or ended — a resolve with
					// `resolved_incidents` off is exactly this case.
					yield* syncLiveActivities(event, registered).pipe(Effect.ignore)
					return { ...empty, skipped }
				}

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
				// After the notifications, and never in front of them: a Lock Screen
				// activity is the follow-up to the buzz, not a replacement for it.
				yield* syncLiveActivities(event, registered).pipe(Effect.ignore)
				yield* Effect.annotateCurrentSpan({
					"maple.push.sent": sent,
					"maple.push.failed": failed,
					"maple.push.unregistered": unregistered,
				})
				return { sent, failed, unregistered, skipped }
			})

			/**
			 * The Lock Screen half of a critical incident.
			 *
			 * A `trigger` starts an activity on every phone that handed over a
			 * push-to-start token — the app need never have been opened. A
			 * `renotify` refreshes the numbers on the activities that are running,
			 * and a `resolve` ends them with a final "recovered" state that clears
			 * itself a few minutes later.
			 *
			 * Best effort in the same sense as the alert push: this runs after the
			 * notifications have gone out, and every failure is a log line.
			 */
			const syncLiveActivities = Effect.fn("MobilePushService.syncLiveActivities")(function* (
				event: IncidentPushEvent,
				registered: ReadonlyArray<MobileDevice>,
			) {
				// `test` never touches the Lock Screen: a rule being tried out must
				// not put a fake incident in front of someone.
				if (event.eventType === "test") return
				const nowMs = yield* Clock.currentTimeMillis
				// Read once per event, and only past the point where we know an
				// activity will actually receive it — see `recentValues`.
				const contentStateFor = Effect.fn("MobilePushService.liveActivityContentState")(function* () {
					const recent =
						event.recentValues === undefined
							? []
							: // Cause, not error: the typed channel is already `never`, so the
								// only way this read hurts anyone is a defect — and a chart is
								// not worth losing the push that puts a critical incident on
								// someone's Lock Screen.
								yield* event.recentValues.pipe(
									Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<number>)),
								)
					return renderLiveActivityState(event, nowMs, buildLiveActivitySeries(event, recent))
				})

				if (event.eventType === "trigger") {
					// Warnings stay in the notification list. A Live Activity occupies
					// the Lock Screen until it is dealt with, which is a claim only a
					// critical incident earns.
					if (event.severity !== "critical") return
					const starters = registered.flatMap((device) =>
						device.liveActivityStartToken !== null && device.preferences.criticalIncidents
							? [{ device, startToken: device.liveActivityStartToken }]
							: [],
					)
					if (starters.length === 0) return
					const attributes = renderLiveActivityAttributes(event, nowMs)
					const contentState = yield* contentStateFor()
					yield* Effect.forEach(
						starters,
						({ device, startToken }) =>
							apns
								.sendLiveActivity({
									pushToken: startToken,
									environment: device.environment,
									bundleId: device.bundleId,
									event: "start",
									attributesType: LIVE_ACTIVITY_ATTRIBUTES_TYPE,
									attributes,
									contentState,
									staleAfterSeconds: LIVE_ACTIVITY_STALE_SECONDS,
								})
								.pipe(
									Effect.timeout(SEND_TIMEOUT),
									Effect.flatMap((result) =>
										result.outcome === "sent"
											? Effect.void
											: Effect.logWarning("Live Activity: start push rejected").pipe(
													Effect.annotateLogs({
														orgId: event.orgId,
														deviceId: device.id,
														incidentId: event.incidentId,
														reason:
															result.outcome === "unregistered"
																? result.reason
																: result.reason,
													}),
												),
									),
									// A dead push-to-start token does not mean a dead device:
									// the notification token is separate, so nothing is
									// disabled here.
									Effect.ignore,
								),
						{ concurrency: SEND_CONCURRENCY, discard: true },
					)
					return
				}

				const running = yield* activities
					.listActive(event.orgId, event.incidentId)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("Live Activity: could not list running activities").pipe(
								Effect.annotateLogs({ orgId: event.orgId, error: error.message }),
								Effect.as([] as ReadonlyArray<LiveActivity>),
							),
						),
					)
				if (running.length === 0) return
				const contentState = yield* contentStateFor()

				const byDeviceId = new Map(registered.map((device) => [device.id as string, device]))
				const isEnd = event.eventType === "resolve"
				yield* Effect.forEach(
					running,
					(activity) =>
						Effect.gen(function* () {
							const device = byDeviceId.get(activity.deviceId)
							// The device unregistered while its activity was running.
							// Nothing can be pushed without knowing which APNs host to
							// use, so the row is closed rather than retried forever.
							if (device === undefined) {
								yield* activities.end(activity.id, "device_unregistered").pipe(Effect.ignore)
								return
							}
							const result = yield* apns
								.sendLiveActivity({
									pushToken: activity.pushToken,
									environment: device.environment,
									bundleId: device.bundleId,
									event: isEnd ? "end" : "update",
									contentState,
									staleAfterSeconds: LIVE_ACTIVITY_STALE_SECONDS,
									dismissAfterSeconds: isEnd ? LIVE_ACTIVITY_DISMISS_SECONDS : undefined,
									// An update nobody is looking at should not wake the
									// phone; the end is worth delivering promptly.
									priority: isEnd ? 10 : 5,
								})
								.pipe(
									Effect.timeout(SEND_TIMEOUT),
									Effect.orElseSucceed(() => ({
										outcome: "failed" as const,
										status: 0,
										reason: "send_failed",
										retryable: true,
									})),
								)
							// The row closes when the incident resolved, or when Apple says
							// the activity's token is gone — the user dismissed it.
							const endedReason = isEnd
								? "incident_resolved"
								: result.outcome === "unregistered"
									? result.reason
									: null
							if (endedReason !== null) {
								yield* activities.end(activity.id, endedReason).pipe(Effect.ignore)
							}
							if (result.outcome === "failed") {
								yield* Effect.logWarning("Live Activity: update push rejected").pipe(
									Effect.annotateLogs({
										orgId: event.orgId,
										incidentId: event.incidentId,
										status: result.status,
										reason: result.reason,
									}),
								)
							}
						}),
					{ concurrency: SEND_CONCURRENCY, discard: true },
				)
			})

			return { notifyIncident } satisfies MobilePushServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
