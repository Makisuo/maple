import { assert, describe, expect, it } from "@effect/vitest"
import { encodePublicId } from "@maple/domain/http/v2"
import { MobileDeviceId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { ApnsClient, type ApnsLiveActivityPush, type ApnsPush, type ApnsSendResult } from "@/platform/Apns"
import { LiveActivitiesService, type LiveActivity } from "./LiveActivitiesService"
import { MobileDevicesService, type MobileDevice } from "./MobileDevicesService"
import {
	MobilePushService,
	buildLiveActivitySeries,
	renderDigestPush,
	renderIncidentPush,
	shouldPushRenotify,
	type IncidentPushEvent,
} from "./MobilePushService"

const ORG = Schema.decodeUnknownSync(OrgId)("org_push_test")
const USER = Schema.decodeUnknownSync(UserId)("user_push_test")
const deviceId = (n: number) =>
	Schema.decodeUnknownSync(MobileDeviceId)(`00000000-0000-4000-8000-00000000000${n}`)

const device = (n: number, overrides: Partial<MobileDevice> = {}): MobileDevice => ({
	id: deviceId(n),
	orgId: ORG,
	userId: USER,
	platform: "ios",
	token: `token-${n}`,
	environment: "production",
	bundleId: "com.maple.mobile",
	appVersion: null,
	deviceName: null,
	liveActivityStartToken: `start-${n}`,
	preferences: {
		criticalIncidents: true,
		warningIncidents: true,
		resolvedIncidents: true,
		newErrorIssues: false,
		anomalies: false,
	},
	enabled: true,
	lastSeenAtMs: 0,
	createdAtMs: 0,
	...overrides,
})

const event = (overrides: Partial<IncidentPushEvent> = {}): IncidentPushEvent => ({
	orgId: ORG,
	eventType: "trigger",
	incidentId: "inc-1",
	ruleId: "rule-1",
	ruleName: "Checkout error rate",
	severity: "critical",
	signalType: "error_rate",
	signalDisplay: { label: "Error Rate", unit: "ratio" },
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	value: 0.091,
	groupKey: null,
	serviceNames: ["checkout-api"],
	windowMinutes: 5,
	dedupeKey: "rule-1:__total__",
	openForMs: null,
	linkUrl: "https://app.maple.dev/alerts",
	...overrides,
})

/** What a running Live Activity looks like to the fan-out. */
const activity = (n: number, overrides: Partial<LiveActivity> = {}): LiveActivity => ({
	id: `act-${n}`,
	orgId: ORG,
	deviceId: deviceId(n),
	incidentId: "inc-1",
	activityId: `activity-${n}`,
	pushToken: `update-${n}`,
	endedAtMs: null,
	createdAtMs: 0,
	...overrides,
})

interface LiveActivityRecorder {
	readonly pushes: Array<ApnsLiveActivityPush>
	readonly ended: Array<string>
}

const makeLayer = (
	devices: ReadonlyArray<MobileDevice>,
	sendImpl: (push: ApnsPush) => ApnsSendResult,
	sent: Array<ApnsPush>,
	disabled: Array<string>,
	configured = true,
	live: LiveActivityRecorder = { pushes: [], ended: [] },
	running: ReadonlyArray<LiveActivity> = [],
	liveSendImpl: (push: ApnsLiveActivityPush) => ApnsSendResult = () => ({
		outcome: "sent",
		apnsId: null,
	}),
) =>
	MobilePushService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ApnsClient, {
					isConfigured: configured,
					send: (push) => {
						sent.push(push)
						return Effect.succeed(sendImpl(push))
					},
					sendLiveActivity: (push) => {
						live.pushes.push(push)
						return Effect.succeed(liveSendImpl(push))
					},
				}),
				Layer.succeed(MobileDevicesService, {
					register: () => Effect.die("unused"),
					unregister: () => Effect.die("unused"),
					find: () => Effect.die("unused"),
					listForUser: () => Effect.die("unused"),
					listForOrg: () => Effect.succeed(devices),
					disable: (id, reason) => {
						disabled.push(`${id}:${reason}`)
						return Effect.void
					},
					markPushed: () => Effect.void,
				}),
				Layer.succeed(LiveActivitiesService, {
					register: () => Effect.die("unused"),
					listActive: () => Effect.succeed(running),
					end: (id, reason) => {
						live.ended.push(`${id}:${reason}`)
						return Effect.void
					},
					endForDevice: () => Effect.die("unused"),
				}),
			),
		),
	)

describe("renderIncidentPush", () => {
	it("leads with the state, then the rule, and puts the breach in the body", () => {
		const rendered = renderIncidentPush(event())
		expect(rendered.alert).toEqual({
			title: "Critical · Checkout error rate",
			subtitle: "checkout-api",
			body: "Error Rate 9.1% > 5% over 5m.",
		})
		expect(rendered.interruptionLevel).toBe("time-sensitive")
		expect(rendered.priority).toBe(10)
	})

	it("keeps warnings out of Focus, and resolutions quiet and silent", () => {
		expect(renderIncidentPush(event({ severity: "warning" })).interruptionLevel).toBe("active")
		const resolved = renderIncidentPush(
			event({ eventType: "resolve", value: 0.012, openForMs: 32 * 60_000 }),
		)
		expect(resolved.alert.title).toBe("Resolved · Checkout error rate")
		expect(resolved.alert.body).toBe("Error Rate back to 1.2% after 32m.")
		expect(resolved.interruptionLevel).toBe("passive")
		expect(resolved.priority).toBe(5)
		// Explicitly no sound — the APNs client defaults to one otherwise.
		expect(resolved.sound).toBe(null)
	})

	it("says how long a repeat has been going on", () => {
		const rendered = renderIncidentPush(event({ eventType: "renotify", openForMs: 2 * 3_600_000 }))
		expect(rendered.alert.title).toBe("Still critical · Checkout error rate")
		expect(rendered.alert.subtitle).toBe("checkout-api · open 2h")
	})

	it("names the group for grouped rules and counts extra services", () => {
		expect(renderIncidentPush(event({ groupKey: "worker" })).alert.subtitle).toBe("worker")
		expect(renderIncidentPush(event({ serviceNames: ["a", "b", "c"] })).alert.subtitle).toBe("a +2")
		expect(renderIncidentPush(event({ serviceNames: [] })).alert.subtitle).toBeUndefined()
	})
})

describe("shouldPushRenotify", () => {
	const repeat = (
		previousMinutes: number,
		minutes: number,
		severity: "critical" | "warning" = "critical",
	) =>
		shouldPushRenotify(
			event({
				eventType: "renotify",
				severity,
				previousNotifiedOpenForMs: previousMinutes * 60_000,
				openForMs: minutes * 60_000,
			}),
		)

	it("repeats on the ladder and stays quiet between its rungs", () => {
		// A rule renotifying every 30 minutes: 30m, 1h and 2h ring; 1h30 and
		// 2h30 do not.
		expect(repeat(0, 30)).toBe(true)
		expect(repeat(30, 60)).toBe(true)
		expect(repeat(60, 90)).toBe(false)
		expect(repeat(90, 120)).toBe(true)
		expect(repeat(120, 150)).toBe(false)
		expect(repeat(210, 240)).toBe(true)
	})

	it("cannot skip a rung when a tick runs late or the interval is long", () => {
		// A two-hour renotify interval crosses two rungs at once — still one push.
		expect(repeat(0, 120)).toBe(true)
		expect(repeat(120, 240)).toBe(true)
		// Past the last rung, twice a day.
		expect(repeat(480, 720)).toBe(false)
		expect(repeat(480, 1200)).toBe(true)
	})

	it("never repeats a warning on a phone", () => {
		expect(repeat(0, 30, "warning")).toBe(false)
		expect(repeat(480, 1200, "warning")).toBe(false)
	})
})

describe("renderDigestPush", () => {
	it("counts the incidents it stands in for", () => {
		const rendered = renderDigestPush({
			orgId: ORG,
			ruleId: "rule-1",
			ruleName: "Checkout error rate",
			severity: "critical",
			suppressed: 17,
			linkUrl: "https://app.maple.dev/alerts",
		})
		expect(rendered.alert.title).toBe("Critical · Checkout error rate")
		expect(rendered.alert.subtitle).toBe("17 more groups breaching")
		// Loud enough to be seen, never loud enough to break through Focus: the
		// front of this storm already did that.
		expect(rendered.interruptionLevel).toBe("active")
	})
})

describe("MobilePushService.notifyIncident", () => {
	it.effect("sends to every device that wants the event and collapses on the incident stream", () => {
		const sent: Array<ApnsPush> = []
		const disabled: Array<string> = []
		const devices = [
			device(1),
			device(2, { preferences: { ...device(2).preferences, criticalIncidents: false } }),
			device(3, { environment: "sandbox" }),
		]
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			const summary = yield* push.notifyIncident(event())
			assert.deepStrictEqual(summary, { sent: 2, failed: 0, unregistered: 0, skipped: 1 })
			assert.deepStrictEqual(
				sent.map((p) => [p.deviceToken, p.environment, p.collapseId, p.threadId]),
				[
					["token-1", "production", "rule-1:__total__", "rule-1"],
					["token-3", "sandbox", "rule-1:__total__", "rule-1"],
				],
			)
			assert.deepStrictEqual(sent[0]!.data, {
				maple_kind: "alert_incident",
				maple_event: "trigger",
				// Public ids, not the internal ones: the phone hands these back to
				// the v2 API, which rejects anything unprefixed.
				maple_incident_id: encodePublicId("inc", "inc-1"),
				maple_rule_id: encodePublicId("alrt", "rule-1"),
				maple_org_id: ORG,
				maple_url: "https://app.maple.dev/alerts",
			})
		}).pipe(Effect.provide(makeLayer(devices, () => ({ outcome: "sent", apnsId: "x" }), sent, disabled)))
	})

	it.effect("disables a device Apple says is gone and keeps going for the rest", () => {
		const sent: Array<ApnsPush> = []
		const disabled: Array<string> = []
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			const summary = yield* push.notifyIncident(event({ eventType: "resolve" }))
			assert.deepStrictEqual(summary, { sent: 1, failed: 1, unregistered: 1, skipped: 0 })
			assert.deepStrictEqual(disabled, [`${deviceId(2)}:Unregistered`])
		}).pipe(
			Effect.provide(
				makeLayer(
					[device(1), device(2), device(3)],
					(push) =>
						push.deviceToken === "token-2"
							? { outcome: "unregistered", reason: "Unregistered" }
							: push.deviceToken === "token-3"
								? {
										outcome: "failed",
										status: 500,
										reason: "InternalServerError",
										retryable: true,
									}
								: { outcome: "sent", apnsId: null },
					sent,
					disabled,
				),
			),
		)
	})

	it.effect("holds back a repeat between the ladder's rungs, and files resolutions separately", () => {
		const sent: Array<ApnsPush> = []
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			// 1h30 open, last notified at 1h: no rung crossed, so no banner —
			// but the Lock Screen still gets the new numbers.
			const quiet = yield* push.notifyIncident(
				event({
					eventType: "renotify",
					previousNotifiedOpenForMs: 60 * 60_000,
					openForMs: 90 * 60_000,
				}),
			)
			assert.deepStrictEqual(quiet, { sent: 0, failed: 0, unregistered: 0, skipped: 1 })
			assert.strictEqual(sent.length, 0)
			assert.deepStrictEqual(
				live.pushes.map((p) => p.event),
				["update"],
			)

			yield* push.notifyIncident(event({ eventType: "resolve", openForMs: 90 * 60_000 }))
			assert.deepStrictEqual(
				sent.map((p) => [p.threadId, p.sound]),
				[["rule-1:resolved", null]],
			)
		}).pipe(
			Effect.provide(
				makeLayer([device(1)], () => ({ outcome: "sent", apnsId: null }), sent, [], true, live, [
					activity(1),
				]),
			),
		)
	})

	it.effect("is a no-op without APNs credentials", () => {
		const sent: Array<ApnsPush> = []
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			const summary = yield* push.notifyIncident(event())
			assert.deepStrictEqual(summary, { sent: 0, failed: 0, unregistered: 0, skipped: 0 })
			assert.strictEqual(sent.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer([device(1)], () => ({ outcome: "sent", apnsId: null }), sent, [], false),
			),
		)
	})
})

describe("buildLiveActivitySeries", () => {
	it("puts the checks oldest-first and appends the value that fired this push", () => {
		// `listRuleChecks` returns newest first, and the check that just fired is
		// usually still in flight through the ingest pipeline — so the current
		// value has to be appended or the chart lags the number beside it.
		expect(buildLiveActivitySeries(event({ value: 0.091 }), [0.074, 0.052, 0.031])).toEqual([
			0.031, 0.052, 0.074, 0.091,
		])
	})

	it("keeps the last twelve points and drops non-finite ones", () => {
		const many = Array.from({ length: 40 }, (_, index) => index)
		const series = buildLiveActivitySeries(event({ value: 99 }), many.slice().reverse())
		expect(series).toHaveLength(12)
		expect(series.at(-1)).toBe(99)
		expect(series.at(0)).toBe(29)
		expect(buildLiveActivitySeries(event({ value: 1 }), [Number.NaN, 2])).toEqual([2, 1])
	})

	it("is just the value when there is no history, and empty when there is neither", () => {
		expect(buildLiveActivitySeries(event({ value: 0.09 }), [])).toEqual([0.09])
		expect(buildLiveActivitySeries(event({ value: null }), [])).toEqual([])
	})
})

describe("MobilePushService live activities", () => {
	it.effect("starts one on every phone with a push-to-start token when a critical incident opens", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			yield* push.notifyIncident(event({ recentValues: Effect.succeed([0.074, 0.052, 0.031]) }))
			assert.deepStrictEqual(
				live.pushes.map((p) => [p.pushToken, p.event, p.environment]),
				[
					["start-1", "start", "production"],
					["start-3", "start", "sandbox"],
				],
			)
			const [first] = live.pushes
			assert.strictEqual(first!.attributesType, "IncidentActivityAttributes")
			assert.deepStrictEqual(first!.attributes, {
				incident_id: encodePublicId("inc", "inc-1"),
				rule_name: "Checkout error rate",
				service: "checkout-api",
				signal_label: "Error Rate",
				// Epoch seconds, never an ISO string — ActivityKit decodes this
				// dictionary with a plain JSONDecoder.
				started_at: first!.attributes!.started_at,
				organization_id: ORG,
			})
			assert.strictEqual(typeof first!.attributes!.started_at, "number")
			assert.deepStrictEqual(
				{ ...first!.contentState, updated_at: 0 },
				{
					value: "9.1%",
					threshold: "> 5%",
					status: "firing",
					updated_at: 0,
					// The chart: recent checks oldest-first, then the current value.
					series: [0.031, 0.052, 0.074, 0.091],
					// Raw, not formatted — the sparkline rules it off in the series' units.
					threshold_value: 0.05,
				},
			)
		}).pipe(
			Effect.provide(
				makeLayer(
					[
						device(1),
						// Opted out of critical pushes: no banner, and no Lock Screen.
						device(2, { preferences: { ...device(2).preferences, criticalIncidents: false } }),
						device(3, { environment: "sandbox" }),
						// iOS with Live Activities switched off.
						device(4, { liveActivityStartToken: null }),
					],
					() => ({ outcome: "sent", apnsId: null }),
					[],
					[],
					true,
					live,
				),
			),
		)
	})

	it.effect("never lets the chart read fail the push", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			yield* push.notifyIncident(event({ recentValues: Effect.die("the warehouse is having a day") }))
			// Started anyway, with just the current value as the series.
			assert.deepStrictEqual(
				live.pushes.map((p) => p.event),
				["start"],
			)
			assert.deepStrictEqual(live.pushes[0]!.contentState.series, [0.091])
		}).pipe(
			Effect.provide(
				makeLayer([device(1)], () => ({ outcome: "sent", apnsId: null }), [], [], true, live),
			),
		)
	})

	it.effect("leaves the Lock Screen alone for a warning", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			yield* push.notifyIncident(event({ severity: "warning" }))
			assert.strictEqual(live.pushes.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer([device(1)], () => ({ outcome: "sent", apnsId: null }), [], [], true, live),
			),
		)
	})

	it.effect("updates the running activities on a renotify and ends them on a resolve", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		const running = [activity(1)]
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			yield* push.notifyIncident(event({ eventType: "renotify" }))
			assert.deepStrictEqual(
				live.pushes.map((p) => [p.pushToken, p.event, p.dismissAfterSeconds]),
				[["update-1", "update", undefined]],
			)
			assert.deepStrictEqual(live.ended, [])

			yield* push.notifyIncident(event({ eventType: "resolve", value: 0.012 }))
			const end = live.pushes[1]!
			assert.strictEqual(end.event, "end")
			assert.strictEqual(end.contentState.status, "resolved")
			assert.strictEqual(end.contentState.value, "1.2%")
			// The activity clears itself rather than sitting there resolved forever.
			assert.strictEqual(end.dismissAfterSeconds, 5 * 60)
			assert.deepStrictEqual(live.ended, ["act-1:incident_resolved"])
		}).pipe(
			Effect.provide(
				makeLayer(
					[device(1)],
					() => ({ outcome: "sent", apnsId: null }),
					[],
					[],
					true,
					live,
					running,
				),
			),
		)
	})

	it.effect("closes the row when the user dismissed the activity", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			yield* push.notifyIncident(event({ eventType: "renotify" }))
			assert.deepStrictEqual(live.ended, ["act-1:Unregistered"])
		}).pipe(
			Effect.provide(
				makeLayer(
					[device(1)],
					() => ({ outcome: "sent", apnsId: null }),
					[],
					[],
					true,
					live,
					[activity(1)],
					() => ({ outcome: "unregistered", reason: "Unregistered" }),
				),
			),
		)
	})

	it.effect("still ends the activity when nobody wants the resolve notification", () => {
		const live: LiveActivityRecorder = { pushes: [], ended: [] }
		const quiet = device(1, {
			preferences: { ...device(1).preferences, resolvedIncidents: false },
		})
		return Effect.gen(function* () {
			const push = yield* MobilePushService
			const summary = yield* push.notifyIncident(event({ eventType: "resolve" }))
			assert.deepStrictEqual(summary, { sent: 0, failed: 0, unregistered: 0, skipped: 1 })
			assert.deepStrictEqual(
				live.pushes.map((p) => p.event),
				["end"],
			)
		}).pipe(
			Effect.provide(
				makeLayer([quiet], () => ({ outcome: "sent", apnsId: null }), [], [], true, live, [
					activity(1),
				]),
			),
		)
	})
})
