import { createHmac } from "node:crypto"
import {
	AlertDeliveryError,
	type AlertComparator,
	type AlertDestinationType,
	type AlertEventType,
	type AlertSeverity,
	type AlertSignalType,
} from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/db"
import { Duration, Effect, Match, Option } from "effect"
import type { EnrichedDestinationSecretConfig } from "./AlertDestinationHydration"

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface DestinationPublicConfig {
	readonly summary: string
	readonly channelLabel: string | null
}

export interface DispatchContext {
	readonly deliveryKey: string
	readonly destination: AlertDestinationRow
	readonly publicConfig: DestinationPublicConfig
	readonly secretConfig: EnrichedDestinationSecretConfig
	readonly ruleId: string
	readonly ruleName: string
	readonly groupKey: string | null
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly eventType: AlertEventType
	readonly incidentId: string | null
	readonly incidentStatus: string
	readonly dedupeKey: string
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
}

export interface DispatchResult {
	readonly providerMessage: string | null
	readonly providerReference: string | null
	readonly responseCode: number | null
}

/* -------------------------------------------------------------------------- */
/*  Chat deep-link helper                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatUrlContext {
	readonly ruleId: string
	readonly ruleName: string
	readonly incidentId: string | null
	readonly dedupeKey: string
	readonly eventType: AlertEventType
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly value: number | null
	readonly windowMinutes: number
	readonly groupKey: string | null
	readonly sampleCount: number | null
}

const toBase64Url = (raw: string): string =>
	Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const buildAlertChatUrl = (baseUrl: string, context: ChatUrlContext): string => {
	const alertJson = JSON.stringify({
		ruleId: context.ruleId,
		ruleName: context.ruleName,
		incidentId: context.incidentId,
		eventType: context.eventType,
		signalType: context.signalType,
		severity: context.severity,
		comparator: context.comparator,
		threshold: context.threshold,
		thresholdUpper: context.thresholdUpper,
		value: context.value,
		windowMinutes: context.windowMinutes,
		groupKey: context.groupKey,
		sampleCount: context.sampleCount,
	})
	const tabId = `alert-${context.incidentId ?? context.dedupeKey}`
	const params = new URLSearchParams({
		mode: "alert",
		tab: tabId,
		alert: toBase64Url(alertJson),
	})
	return `${baseUrl}/chat?${params.toString()}`
}

/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

const round = (value: number, decimals = 2): string => {
	const factor = 10 ** decimals
	return (Math.round(value * factor) / factor).toString()
}

export const formatComparator = (
	value: AlertComparator,
	threshold?: number,
	thresholdUpper?: number | null,
): string => {
	const operator = Match.value(value).pipe(
		Match.when("gt", () => ">"),
		Match.when("gte", () => ">="),
		Match.when("lt", () => "<"),
		Match.when("lte", () => "<="),
		Match.when("eq", () => "="),
		Match.when("neq", () => "!="),
		Match.when("between", () => "between"),
		Match.when("not_between", () => "not between"),
		Match.exhaustive,
	)
	if (threshold == null) return operator
	if (value === "between" || value === "not_between") {
		const upper = thresholdUpper ?? threshold
		return `${operator} ${threshold} and ${upper}`
	}
	return `${operator} ${threshold}`
}

export const formatSignalLabel = (signal: string) => {
	const labels: Record<string, string> = {
		error_rate: "Error Rate",
		p95_latency: "P95 Latency",
		p99_latency: "P99 Latency",
		apdex: "Apdex",
		throughput: "Throughput",
		metric: "Metric",
	}
	return labels[signal] ?? signal
}

const eventTypeEmoji = (type: string) => {
	const map: Record<string, string> = {
		trigger: "\u{1F6A8}",
		resolve: "\u2705",
		renotify: "\u{1F514}",
		test: "\u{1F9EA}",
	}
	return map[type] ?? "\u{1F4E2}"
}

export const formatEventTypeLabel = (type: string) => {
	const map: Record<string, string> = {
		trigger: "Triggered",
		resolve: "Resolved",
		renotify: "Re-notification",
		test: "Test",
	}
	return map[type] ?? type
}

export const formatSignalMetric = (value: number | null, signalType: string): string =>
	Option.match(Option.fromNullishOr(value), {
		onNone: () => "n/a",
		onSome: (v) =>
			Match.value(signalType).pipe(
				Match.when("error_rate", () => `${round(v)}%`),
				Match.whenOr("p95_latency", "p99_latency", () => `${round(v)}ms`),
				Match.when("apdex", () => `${round(v, 3)}`),
				Match.when("throughput", () => `${round(v)} rpm`),
				Match.orElse(() => `${round(v)}`),
			),
	})

const formatWindow = (minutes: number): string => {
	if (minutes < 60) return `${minutes}m`
	const hours = minutes / 60
	return hours % 1 === 0 ? `${hours}h` : `${minutes}m`
}

const slackAttachmentColor = (eventType: string, severity: string): string => {
	if (eventType === "resolve") return "#2eb67d"
	if (eventType === "test") return "#36c5f0"
	if (severity === "critical") return "#e01e5a"
	return "#ecb22e" // warning
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

const makeDeliveryError = (message: string, destinationType?: AlertDestinationType) =>
	new AlertDeliveryError({ message, destinationType })

const runTimedFetch = <A>(
	destinationType: AlertDestinationType,
	label: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	request: () => Promise<A>,
) =>
	Effect.tryPromise({
		try: () => request(),
		catch: (error) =>
			makeDeliveryError(
				error instanceof Error ? error.message : `${label} delivery failed`,
				destinationType,
			),
	}).pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.fail(
					makeDeliveryError(`${label} delivery timed out after ${timeoutMs}ms`, destinationType),
				),
		}),
	)

const buildSlackBlocks = (context: DispatchContext, linkUrl: string, chatUrl: string) => [
	{
		type: "header",
		text: {
			type: "plain_text",
			text: `${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
			emoji: true,
		},
	},
	{
		type: "section",
		fields: [
			{ type: "mrkdwn", text: `*Severity*\n${context.severity}` },
			{ type: "mrkdwn", text: `*Signal*\n${formatSignalLabel(context.signalType)}` },
			{ type: "mrkdwn", text: `*Group*\n${context.groupKey ?? "all"}` },
			{
				type: "mrkdwn",
				text: `*Observed*\n${formatSignalMetric(context.value, context.signalType)} ${
					context.comparator === "between" || context.comparator === "not_between"
						? `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)} and ${formatSignalMetric(context.thresholdUpper ?? context.threshold, context.signalType)}`
						: `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)}`
				}`,
			},
			{ type: "mrkdwn", text: `*Window*\n${formatWindow(context.windowMinutes)}` },
		],
	},
	{ type: "divider" },
	{
		type: "actions",
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: "Open in Maple", emoji: true },
				url: linkUrl,
				...(context.eventType !== "resolve" && { style: "danger" }),
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Ask Maple AI", emoji: true },
				url: chatUrl,
				style: "primary",
			},
		],
	},
	{
		type: "context",
		elements: [{ type: "mrkdwn", text: "\u{1F341} Maple Alerts" }],
	},
]

export const dispatchDelivery = (
	context: DispatchContext,
	payloadJson: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	linkUrl: string,
	chatUrl: string,
): Effect.Effect<DispatchResult, AlertDeliveryError> =>
	Effect.gen(function* () {
		return yield* Match.value(context.secretConfig).pipe(
			Match.discriminatorsExhaustive("type")({
				slack: (config) =>
					Effect.gen(function* () {
						const response = yield* runTimedFetch("slack", "Slack", fetchFn, timeoutMs, () =>
							fetchFn(config.webhookUrl, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									text: `${context.ruleName}: ${formatEventTypeLabel(context.eventType)}`,
									attachments: [
										{
											color: slackAttachmentColor(context.eventType, context.severity),
											blocks: buildSlackBlocks(context, linkUrl, chatUrl),
										},
									],
								}),
							}),
						)
						if (!response.ok) {
							return yield* Effect.fail(
								makeDeliveryError(`Slack delivery failed with ${response.status}`, "slack"),
							)
						}
						return {
							providerMessage: "Delivered to Slack",
							providerReference: null,
							responseCode: response.status,
						} as DispatchResult
					}),
				pagerduty: (config) =>
					Effect.gen(function* () {
						const body = {
							routing_key: config.integrationKey,
							event_action: context.eventType === "resolve" ? "resolve" : "trigger",
							dedup_key: context.dedupeKey,
							payload: {
								summary: `${context.ruleName} ${context.eventType}`,
								source: context.groupKey ?? "maple-alerts",
								severity: context.severity === "critical" ? "critical" : "warning",
								custom_details: {
									ruleName: context.ruleName,
									signalType: context.signalType,
									value: context.value,
									threshold: context.threshold,
									thresholdUpper: context.thresholdUpper,
									comparator: context.comparator,
									groupKey: context.groupKey,
									linkUrl,
									chatUrl,
								},
							},
							links: [
								{ href: linkUrl, text: "Open in Maple" },
								{ href: chatUrl, text: "Ask Maple AI" },
							],
						}
						const response = yield* runTimedFetch(
							"pagerduty",
							"PagerDuty",
							fetchFn,
							timeoutMs,
							() =>
								fetchFn("https://events.pagerduty.com/v2/enqueue", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify(body),
								}),
						)
						if (!response.ok) {
							return yield* Effect.fail(
								makeDeliveryError(
									`PagerDuty delivery failed with ${response.status}`,
									"pagerduty",
								),
							)
						}
						return {
							providerMessage: "Delivered to PagerDuty",
							providerReference: context.dedupeKey,
							responseCode: response.status,
						} as DispatchResult
					}),
				webhook: (config) =>
					Effect.gen(function* () {
						const headers: Record<string, string> = {
							"content-type": "application/json",
							"x-maple-event-type": context.eventType,
							"x-maple-delivery-key": context.deliveryKey,
						}
						if (config.signingSecret) {
							headers["x-maple-signature"] = createHmac("sha256", config.signingSecret)
								.update(payloadJson)
								.digest("hex")
						}
						const response = yield* runTimedFetch("webhook", "Webhook", fetchFn, timeoutMs, () =>
							fetchFn(config.url, { method: "POST", headers, body: payloadJson }),
						)
						if (!response.ok) {
							return yield* Effect.fail(
								makeDeliveryError(
									`Webhook delivery failed with ${response.status}`,
									"webhook",
								),
							)
						}
						return {
							providerMessage: "Delivered to webhook",
							providerReference: context.dedupeKey,
							responseCode: response.status,
						} as DispatchResult
					}),
				hazel: (config) =>
					Effect.gen(function* () {
						const headers: Record<string, string> = {
							"content-type": "application/json",
							"x-maple-event-type": context.eventType,
							"x-maple-delivery-key": context.deliveryKey,
						}
						if (config.signingSecret) {
							headers["x-maple-signature"] = createHmac("sha256", config.signingSecret)
								.update(payloadJson)
								.digest("hex")
						}
						const response = yield* runTimedFetch("hazel", "Hazel", fetchFn, timeoutMs, () =>
							fetchFn(config.webhookUrl, { method: "POST", headers, body: payloadJson }),
						)
						if (!response.ok) {
							return yield* Effect.fail(
								makeDeliveryError(`Hazel delivery failed with ${response.status}`, "hazel"),
							)
						}
						return {
							providerMessage: "Delivered to Hazel",
							providerReference: context.dedupeKey,
							responseCode: response.status,
						} as DispatchResult
					}),
				"hazel-oauth": (config) =>
					Effect.gen(function* () {
						// Hazel exposes per-integration sibling endpoints under the same
						// `:webhookId/:token` prefix (see hazel
						// packages/domain/src/http/incoming-webhooks.ts). The stored
						// webhookUrl is the base; we append `/maple` to hit the
						// `executeMaple` handler — without it, the payload routes to the
						// Discord-style `execute` endpoint and is rejected.
						const hazelUrl = `${config.webhookUrl.replace(/\/$/, "")}/maple`
						const incidentStatus = context.eventType === "resolve" ? "resolved" : "open"
						const body = JSON.stringify({
							eventType: context.eventType,
							incidentId: context.incidentId,
							incidentStatus,
							dedupeKey: context.dedupeKey,
							rule: {
								id: context.ruleId,
								name: context.ruleName,
								signalType: context.signalType,
								severity: context.severity,
								groupKey: context.groupKey,
								comparator: context.comparator,
								threshold: context.threshold,
								windowMinutes: context.windowMinutes,
							},
							observed: {
								value: context.value,
								sampleCount: context.sampleCount,
							},
							linkUrl,
							chatUrl,
							sentAt: new Date().toISOString(),
						})
						const response = yield* runTimedFetch(
							"hazel-oauth",
							"Hazel",
							fetchFn,
							timeoutMs,
							() =>
								fetchFn(hazelUrl, {
									method: "POST",
									headers: {
										"content-type": "application/json",
										"x-maple-event-type": context.eventType,
										"x-maple-delivery-key": context.deliveryKey,
									},
									body,
								}),
						)
						if (response.status === 401 || response.status === 403) {
							return yield* Effect.fail(
								makeDeliveryError(
									"Hazel rejected the webhook token — reconfigure the channel",
									"hazel-oauth",
								),
							)
						}
						if (response.status === 404) {
							return yield* Effect.fail(
								makeDeliveryError(
									"Hazel webhook no longer exists — pick a different channel",
									"hazel-oauth",
								),
							)
						}
						if (!response.ok) {
							return yield* Effect.fail(
								makeDeliveryError(
									`Hazel delivery failed with ${response.status}`,
									"hazel-oauth",
								),
							)
						}
						return {
							providerMessage: `Delivered to Hazel #${config.hazelChannelName}`,
							providerReference: context.dedupeKey,
							responseCode: response.status,
						} as DispatchResult
					}),
			}),
		)
	})
