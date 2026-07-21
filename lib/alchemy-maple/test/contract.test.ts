/**
 * Contract tests: the provider's hand-written wire bodies/decoders must stay
 * compatible with the real `@maple/domain` v2 schemas (dev-only dependency —
 * never shipped). If a v2 schema changes shape, these fail in CI.
 */
import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
	V2AlertDestinationCreateParams,
	V2AlertRuleCreateParams,
	V2ApiKeyCreateParams,
	V2DashboardCreateParams,
} from "@maple/domain/http/v2"
import { _alertDestinationCreateBody } from "../src/AlertDestination"
import { _alertRuleCreateBody } from "../src/AlertRule"
import { _apiKeyCreateBody } from "../src/ApiKey"
import { _dashboardCreateBody } from "../src/Dashboard"

const decodes = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, wire: unknown) =>
	Effect.runSync(Schema.decodeUnknownEffect(schema)(wire).pipe(Effect.asVoid))

describe("provider request bodies decode against the real v2 create-param schemas", () => {
	it("dashboard create body", () => {
		const body = _dashboardCreateBody({
			name: "Service health",
			description: "Golden signals",
			tags: ["golden"],
			time_range: { type: "relative", value: "12h" },
			widgets: [
				{
					id: "w1",
					visualization: "timeseries",
					data_source: { endpoint: "query_builder", params: { granularity_seconds: 60 } },
					display: { title: "Throughput" },
					layout: { x: 0, y: 0, w: 6, h: 4 },
				},
			],
			variables: [{ name: "service", type: "textbox" }],
		})
		expect(() => decodes(V2DashboardCreateParams, body)).not.toThrow()
	})

	it("alert destination create bodies (each channel type)", () => {
		const bodies = [
			_alertDestinationCreateBody({
				type: "slack",
				name: "On-call Slack",
				webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX",
				channel_label: "#incidents",
				enabled: true,
			}),
			_alertDestinationCreateBody({ type: "pagerduty", name: "PD", integration_key: "key" }),
			_alertDestinationCreateBody({
				type: "webhook",
				name: "Hook",
				url: "https://example.com/hooks/maple",
				signing_secret: "shh",
			}),
			_alertDestinationCreateBody({
				type: "hazel",
				name: "Hazel",
				webhook_url: "https://hazel.example.com/hook",
			}),
			_alertDestinationCreateBody({
				type: "discord",
				name: "Discord",
				webhook_url: "https://discord.com/api/webhooks/x",
			}),
			_alertDestinationCreateBody({
				type: "email",
				name: "Email",
				member_user_ids: ["user_2Nk8mXqPfR3yZ1aB4cD5eF6g"],
			}),
		]
		for (const body of bodies) {
			expect(() => decodes(V2AlertDestinationCreateParams, body)).not.toThrow()
		}
	})

	it("alert rule create body", () => {
		const body = _alertRuleCreateBody({
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: ["dest_oybbpTBhtSFGShMjjLiCrh"],
			service_names: ["checkout"],
			tags: ["payments"],
			minimum_sample_count: 50,
		})
		expect(() => decodes(V2AlertRuleCreateParams, body)).not.toThrow()
	})

	it("api key create body", () => {
		const body = _apiKeyCreateBody({
			name: "ci-pipeline",
			description: "Publishes deploys",
			scopes: ["dashboards:write", "alerts:read"],
			kind: "standard",
			expires_in_seconds: 7_776_000,
		})
		expect(() => decodes(V2ApiKeyCreateParams, body)).not.toThrow()
	})
})
