import { assert, describe, expect, it } from "@effect/vitest"
import { MobileDeviceId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { ApnsClient, type ApnsPush, type ApnsSendResult } from "@/platform/Apns"
import { MobileDevicesService, type MobileDevice } from "./MobileDevicesService"
import { MobilePushService, renderIncidentPush, type IncidentPushEvent } from "./MobilePushService"

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

const makeLayer = (
	devices: ReadonlyArray<MobileDevice>,
	sendImpl: (push: ApnsPush) => ApnsSendResult,
	sent: Array<ApnsPush>,
	disabled: Array<string>,
	configured = true,
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
				}),
				Layer.succeed(MobileDevicesService, {
					register: () => Effect.die("unused"),
					unregister: () => Effect.die("unused"),
					listForUser: () => Effect.die("unused"),
					listForOrg: () => Effect.succeed(devices),
					disable: (id, reason) => {
						disabled.push(`${id}:${reason}`)
						return Effect.void
					},
					markPushed: () => Effect.void,
				}),
			),
		),
	)

describe("renderIncidentPush", () => {
	it("puts the rule up top, severity and service in the subtitle, and the breach in the body", () => {
		const rendered = renderIncidentPush(event())
		expect(rendered.alert).toEqual({
			title: "Checkout error rate",
			subtitle: "Critical · checkout-api",
			body: "Error Rate 9.1% > 5% over 5m.",
		})
		expect(rendered.interruptionLevel).toBe("time-sensitive")
		expect(rendered.priority).toBe(10)
	})

	it("keeps warnings out of Focus and resolutions quiet", () => {
		expect(renderIncidentPush(event({ severity: "warning" })).interruptionLevel).toBe("active")
		const resolved = renderIncidentPush(
			event({ eventType: "resolve", value: 0.012, openForMs: 32 * 60_000 }),
		)
		expect(resolved.alert.title).toBe("Resolved: Checkout error rate")
		expect(resolved.alert.body).toBe("Error Rate back to 1.2% after 32m.")
		expect(resolved.interruptionLevel).toBe("passive")
		expect(resolved.priority).toBe(5)
	})

	it("names the group for grouped rules and counts extra services", () => {
		expect(renderIncidentPush(event({ groupKey: "worker" })).alert.subtitle).toBe("Critical · worker")
		expect(renderIncidentPush(event({ serviceNames: ["a", "b", "c"] })).alert.subtitle).toBe(
			"Critical · a +2",
		)
		expect(renderIncidentPush(event({ serviceNames: [] })).alert.subtitle).toBe("Critical")
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
				maple_incident_id: "inc-1",
				maple_rule_id: "rule-1",
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
