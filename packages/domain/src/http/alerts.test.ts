import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	AlertDestinationCreateRequest,
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
})
