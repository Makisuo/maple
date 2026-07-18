import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import {
	AlertDestinationCreateRequest,
	AlertNotificationTemplate,
	AlertRuleUpsertRequest,
	PagerDutyAlertDestinationConfig,
	SlackAlertDestinationConfig,
	WebhookAlertDestinationConfig,
} from "./alerts"

describe("AlertDestinationCreateRequest", () => {
	const encode = Schema.encodeUnknownSync(AlertDestinationCreateRequest)

	// `AlertDestinationCreateRequest` is a `Schema.Union` of `Schema.Class`
	// instances, so `encodeUnknownSync` requires class instances on the input
	// side and produces the plain wire-format object on the output side.
	// These tests assert the encoded wire shape matches what HTTP clients
	// see on the wire.
	it("encodes slack destination instances to the plain wire shape", () => {
		expect(
			encode(
				new SlackAlertDestinationConfig({
					type: "slack",
					name: "Ops Slack",
					enabled: true,
					webhookUrl: "https://hooks.slack.com/services/T/B/X",
					channelLabel: "#ops-alerts",
				}),
			),
		).toEqual({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})
	})

	it("encodes pagerduty and webhook destination instances to the plain wire shape", () => {
		expect(
			encode(
				new PagerDutyAlertDestinationConfig({
					type: "pagerduty",
					name: "PagerDuty",
					enabled: true,
					integrationKey: "integration-key",
				}),
			),
		).toEqual({
			type: "pagerduty",
			name: "PagerDuty",
			enabled: true,
			integrationKey: "integration-key",
		})

		expect(
			encode(
				new WebhookAlertDestinationConfig({
					type: "webhook",
					name: "Webhook",
					enabled: true,
					url: "https://example.com/alerts",
					signingSecret: "secret",
				}),
			),
		).toEqual({
			type: "webhook",
			name: "Webhook",
			enabled: true,
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})
	})

	const decode = Schema.decodeUnknownSync(AlertDestinationCreateRequest)
	const decodeExit = Schema.decodeUnknownExit(AlertDestinationCreateRequest)

	// Decode goes the other direction: plain wire-format objects in, class
	// instances out. The union discriminates on `type`.
	it("decodes a slack wire object into a SlackAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})

		expect(decoded).toBeInstanceOf(SlackAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			webhookUrl: "https://hooks.slack.com/services/T/B/X",
			channelLabel: "#ops-alerts",
		})
	})

	it("decodes a pagerduty wire object into a PagerDutyAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "pagerduty",
			name: "PagerDuty",
			enabled: true,
			integrationKey: "integration-key",
		})

		expect(decoded).toBeInstanceOf(PagerDutyAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "pagerduty",
			name: "PagerDuty",
			integrationKey: "integration-key",
		})
	})

	it("decodes a webhook wire object into a WebhookAlertDestinationConfig instance", () => {
		const decoded = decode({
			type: "webhook",
			name: "Webhook",
			enabled: true,
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})

		expect(decoded).toBeInstanceOf(WebhookAlertDestinationConfig)
		expect(decoded).toMatchObject({
			type: "webhook",
			name: "Webhook",
			url: "https://example.com/alerts",
			signingSecret: "secret",
		})
	})

	it("fails to decode an unknown destination type", () => {
		const result = decodeExit({
			type: "carrier-pigeon",
			name: "Pigeon",
			enabled: true,
		})

		expect(Exit.isFailure(result)).toBe(true)
	})

	it("fails to decode a slack destination missing the required webhookUrl", () => {
		const result = decodeExit({
			type: "slack",
			name: "Ops Slack",
			enabled: true,
			channelLabel: "#ops-alerts",
		})

		expect(Exit.isFailure(result)).toBe(true)
	})
})

describe("AlertNotificationTemplate", () => {
	const decode = Schema.decodeUnknownSync(AlertNotificationTemplate)
	const decodeExit = Schema.decodeUnknownExit(AlertNotificationTemplate)

	it("decodes a title + body + per-destination overrides", () => {
		const decoded = decode({
			title: "{{ rule.name }} fired",
			body: "*Observed:* {{ observed.summary }}",
			overrides: { slack: { body: "slack-only body" } },
		})
		expect(decoded).toEqual({
			title: "{{ rule.name }} fired",
			body: "*Observed:* {{ observed.summary }}",
			overrides: { slack: { body: "slack-only body" } },
		})
	})

	it("decodes an empty template (all fields optional)", () => {
		expect(decode({})).toEqual({})
	})

	it("rejects a title longer than the 4000-char cap", () => {
		const result = decodeExit({ title: "x".repeat(4001) })
		expect(Exit.isFailure(result)).toBe(true)
	})
})

describe("AlertRuleUpsertRequest notificationTemplate", () => {
	const decode = Schema.decodeUnknownSync(AlertRuleUpsertRequest)
	const decodeExit = Schema.decodeUnknownExit(AlertRuleUpsertRequest)

	const baseRule = {
		name: "Checkout errors",
		severity: "critical" as const,
		signalType: "error_rate" as const,
		comparator: "gt" as const,
		threshold: 0.05,
		windowMinutes: 5,
		destinationIds: [],
	}

	it("accepts an embedded notification template", () => {
		const decoded = decode({
			...baseRule,
			notificationTemplate: { title: "T", body: "B" },
		})
		expect(decoded.notificationTemplate).toEqual({ title: "T", body: "B" })
	})

	it("accepts a null template and a fully omitted template", () => {
		expect(decode({ ...baseRule, notificationTemplate: null }).notificationTemplate).toBeNull()
		expect(decode(baseRule).notificationTemplate).toBeUndefined()
	})

	it("rejects alert windows longer than 24 hours", () => {
		expect(Exit.isFailure(decodeExit({ ...baseRule, windowMinutes: 24 * 60 + 1 }))).toBe(true)
	})
})
