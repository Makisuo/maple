import { describe, expect, it } from "vitest"
import {
	alertDeliveryRetryDelayMs,
	canRetryAlertDelivery,
	evaluateAlertObservation,
	interleaveAlertRulesByTenant,
	makeAlertDeliveryKey,
	planAlertLifecycle,
	projectAlertLifecycleEvent,
	type AlertEvaluation,
} from "./index"

const breached: AlertEvaluation = {
	status: "breached",
	value: 11,
	sampleCount: 5,
	threshold: 10,
	thresholdUpper: null,
	comparator: "gt",
	reason: "above threshold",
	derivedFromNoData: false,
}

const healthy: AlertEvaluation = { ...breached, status: "healthy", value: 9 }

const policy = {
	consecutiveBreachesRequired: 2,
	consecutiveHealthyRequired: 2,
	renotifyIntervalMinutes: 10,
}

describe("evaluateAlertObservation", () => {
	it("applies thresholds and rounds weighted sample counts", () => {
		expect(
			evaluateAlertObservation(
				{
					comparator: "between",
					threshold: 10,
					thresholdUpper: 20,
					minimumSampleCount: 2,
					noDataBehavior: "skip",
				},
				{ value: 15, sampleCount: 2.4, hasData: true },
				"inside range",
			),
		).toMatchObject({ status: "breached", sampleCount: 2, reason: "inside range" })
	})

	it("marks a zero synthesized from no data so lifecycle resolution can fail closed", () => {
		expect(
			evaluateAlertObservation(
				{
					comparator: "gt",
					threshold: 10,
					thresholdUpper: null,
					minimumSampleCount: 0,
					noDataBehavior: "zero",
				},
				{ value: null, sampleCount: 0, hasData: false },
				"above threshold",
			),
		).toMatchObject({ status: "healthy", value: 0, derivedFromNoData: true })
	})
})

describe("planAlertLifecycle", () => {
	it("opens only after the configured breach count", () => {
		const first = planAlertLifecycle({
			policy,
			evaluation: breached,
			state: null,
			openIncident: null,
			nowMs: 1_000,
		})
		expect(first).toMatchObject({ transition: "none", state: { consecutiveBreaches: 1 } })

		const second = planAlertLifecycle({
			policy,
			evaluation: breached,
			state: first.state,
			openIncident: null,
			nowMs: 2_000,
		})
		expect(second).toMatchObject({ transition: "opened", eventType: "trigger" })
	})

	it("suppresses a flapping trigger and its matching resolve", () => {
		const opened = planAlertLifecycle({
			policy,
			evaluation: breached,
			state: { consecutiveBreaches: 1, consecutiveHealthy: 0 },
			openIncident: null,
			nowMs: 600_000,
			previousNotificationAtMs: 300_000,
		})
		expect(opened).toMatchObject({
			transition: "opened",
			eventType: null,
			notificationSuppression: "flapping",
			inheritedNotificationAtMs: 300_000,
		})

		const resolved = planAlertLifecycle({
			policy,
			evaluation: healthy,
			state: { consecutiveBreaches: 0, consecutiveHealthy: 1 },
			openIncident: {
				firstTriggeredAtMs: 600_000,
				lastNotifiedAtMs: opened.inheritedNotificationAtMs,
				lastDeliveredEventType: null,
			},
			nowMs: 700_000,
		})
		expect(resolved).toMatchObject({
			transition: "resolved",
			eventType: null,
			notificationSuppression: "flap_resolution",
		})
	})

	it("advances the notification anchor when renotify becomes due", () => {
		const plan = planAlertLifecycle({
			policy,
			evaluation: breached,
			state: { consecutiveBreaches: 2, consecutiveHealthy: 0 },
			openIncident: {
				firstTriggeredAtMs: 0,
				lastNotifiedAtMs: 1_000,
				lastDeliveredEventType: "trigger",
			},
			nowMs: 601_000,
		})
		expect(plan).toMatchObject({
			transition: "continued",
			eventType: "renotify",
			advanceNotificationAnchor: true,
		})
	})

	it("holds a no-data recovery until the host proves telemetry liveness", () => {
		const noDataHealthy = { ...healthy, derivedFromNoData: true }
		const input = {
			policy,
			evaluation: noDataHealthy,
			state: { consecutiveBreaches: 0, consecutiveHealthy: 1 },
			openIncident: {
				firstTriggeredAtMs: 0,
				lastNotifiedAtMs: 0,
				lastDeliveredEventType: "trigger" as const,
			},
			nowMs: 1_000,
		}
		expect(planAlertLifecycle(input)).toMatchObject({ transition: "none", hold: "missing_telemetry" })
		expect(planAlertLifecycle({ ...input, allowNoDataResolution: true })).toMatchObject({
			transition: "resolved",
			eventType: "resolve",
		})
	})
})

describe("interleaveAlertRulesByTenant", () => {
	it("preserves each tenant's order while round-robining tenants", () => {
		const rows = [
			{ tenantId: "a", id: "a1" },
			{ tenantId: "a", id: "a2" },
			{ tenantId: "b", id: "b1" },
			{ tenantId: "a", id: "a3" },
			{ tenantId: "b", id: "b2" },
		]
		expect(interleaveAlertRulesByTenant(rows, (row) => row.tenantId).map(({ id }) => id)).toEqual([
			"a1",
			"b1",
			"a2",
			"b2",
			"a3",
		])
	})
})

describe("delivery policy", () => {
	it("projects lifecycle intents into deterministic common CloudEvents", () => {
		const input = {
			tenantId: "org-1",
			ruleId: "rule-1",
			ruleName: "High errors",
			incidentId: "incident-1",
			eventType: "trigger" as const,
			incidentStatus: "open",
			groupKey: "checkout",
			signalType: "error_rate",
			severity: "critical",
			comparator: "gt" as const,
			threshold: 5,
			thresholdUpper: null,
			windowMinutes: 5,
			value: 7.2,
			sampleCount: 12,
			occurredAtMs: 1_786_131_720_123,
		}
		const event = projectAlertLifecycleEvent(input)
		expect(event).toEqual(projectAlertLifecycleEvent(input))
		expect(event).toMatchObject({
			type: "dev.maple.alert.lifecycle.trigger.v1",
			subject: "alert-incidents/incident-1",
			tenantid: "org-1",
			projectionid: "alert-lifecycle",
			data: { eventType: "trigger", incidentId: "incident-1" },
		})
		expect(() => projectAlertLifecycleEvent({ ...input, occurredAtMs: Number.MAX_SAFE_INTEGER })).toThrow(
			"outside the supported date range",
		)
	})

	it("builds stable idempotency keys", () => {
		expect(makeAlertDeliveryKey("incident", "destination", "trigger", 42)).toBe(
			"incident:destination:trigger:42",
		)
	})

	it("caps exponential retry delay and attempts", () => {
		expect(alertDeliveryRetryDelayMs(1, 123)).toBe(60_123)
		expect(alertDeliveryRetryDelayMs(5, 999)).toBe(900_999)
		expect(canRetryAlertDelivery(4, true)).toBe(true)
		expect(canRetryAlertDelivery(5, true)).toBe(false)
		expect(canRetryAlertDelivery(1, false)).toBe(false)
	})
})
