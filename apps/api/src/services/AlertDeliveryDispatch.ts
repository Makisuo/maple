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
import { Clock, Duration, Effect, Match, Option } from "effect"
import type { EnrichedDestinationSecretConfig } from "./AlertDestinationHydration"
import { safeFetch } from "../lib/url-validator"
// Circular with ./alert-email (it imports our formatting helpers); safe — both
// sides only reference the other's exports inside function bodies.
import { buildAlertEmailContent } from "./alert-email"
import { DEFAULT_BODY_TEMPLATE, DEFAULT_TITLE_TEMPLATE } from "./alert-templating/defaultTemplates"
import {
	hasCustomTemplate,
	renderTemplate,
	resolveTemplate,
	type NotificationTemplateConfig,
	type TemplateContext,
} from "./alert-templating/renderer"

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
	/**
	 * User-customized notification template (title + Markdown body, optional
	 * per-destination overrides). `null`/absent → the built-in hardcoded format.
	 * Snapshotted at enqueue time so retries and post-fire edits stay stable.
	 */
	readonly template?: NotificationTemplateConfig | null
	/** Epoch ms the notification was sent — exposed to templates as `sentAt`. */
	readonly sentAtMs?: number
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

/**
 * "Ask Maple AI" deep-link. Points at the incident-scoped diagnosis page, which
 * auto-generates the AI diagnosis and hosts the alert chat alongside it. The
 * encoded alert context is carried so the page renders + seeds the chat without
 * a round-trip. When there is no incident row yet (e.g. a `test` notification)
 * we fall back to the generic chat surface.
 */
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
	const encoded = toBase64Url(alertJson)
	if (context.incidentId) {
		return `${baseUrl}/alerts/incidents/${encodeURIComponent(context.incidentId)}?alert=${encoded}`
	}
	const params = new URLSearchParams({
		mode: "alert",
		tab: `alert-${context.dedupeKey}`,
		alert: encoded,
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

export const eventTypeEmoji = (type: string) => {
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

const formatSignalMetric = (value: number | null, signalType: string): string =>
	Option.match(Option.fromNullishOr(value), {
		onNone: () => "n/a",
		onSome: (v) =>
			Match.value(signalType).pipe(
				Match.when("error_rate", () => `${round(v * 100, 1)}%`),
				Match.whenOr("p95_latency", "p99_latency", () => `${round(v)}ms`),
				Match.when("apdex", () => `${round(v, 3)}`),
				Match.when("throughput", () => `${round(v)} rpm`),
				Match.orElse(() => `${round(v)}`),
			),
	})

export const formatWindow = (minutes: number): string => {
	if (minutes < 60) return `${minutes}m`
	const hours = minutes / 60
	return hours % 1 === 0 ? `${hours}h` : `${minutes}m`
}

export const slackAttachmentColor = (eventType: string, severity: string): string => {
	if (eventType === "resolve") return "#2eb67d"
	if (eventType === "test") return "#36c5f0"
	if (severity === "critical") return "#e01e5a"
	return "#ecb22e" // warning
}

/** Discord embed colors are decimal ints — the int forms of the Slack hexes. */
const discordEmbedColor = (eventType: string, severity: string): number => {
	if (eventType === "resolve") return 0x2eb67d
	if (eventType === "test") return 0x36c5f0
	if (severity === "critical") return 0xe01e5a
	return 0xecb22e // warning
}

type ObservedContext = Pick<
	DispatchContext,
	"value" | "signalType" | "comparator" | "threshold" | "thresholdUpper"
>

export const formatObservedSummary = (context: ObservedContext): string => {
	const observed = formatSignalMetric(context.value, context.signalType)
	const comparison =
		context.comparator === "between" || context.comparator === "not_between"
			? `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)} and ${formatSignalMetric(context.thresholdUpper ?? context.threshold, context.signalType)}`
			: `${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)}`
	return `${observed} ${comparison}`
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

const buildDiscordEmbeds = (context: DispatchContext, linkUrl: string, chatUrl: string) => [
	{
		title: `${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
		url: linkUrl,
		color: discordEmbedColor(context.eventType, context.severity),
		fields: [
			{ name: "Severity", value: context.severity, inline: true },
			{ name: "Signal", value: formatSignalLabel(context.signalType), inline: true },
			{ name: "Group", value: context.groupKey ?? "all", inline: true },
			{ name: "Observed", value: formatObservedSummary(context), inline: true },
			{ name: "Window", value: formatWindow(context.windowMinutes), inline: true },
			{
				name: "Links",
				value: `[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`,
				inline: false,
			},
		],
		footer: { text: "\u{1F341} Maple Alerts" },
	},
]

/* -------------------------------------------------------------------------- */
/*  Templated notifications                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subset of {@link DispatchContext} the templating layer reads. Narrowed so
 * it can be exercised in tests without constructing a destination row / secret
 * config (which a full `DispatchContext` requires). The full context satisfies it.
 */
export type TemplateRenderContext = Pick<
	DispatchContext,
	| "ruleId"
	| "ruleName"
	| "eventType"
	| "severity"
	| "signalType"
	| "comparator"
	| "threshold"
	| "thresholdUpper"
	| "value"
	| "sampleCount"
	| "groupKey"
	| "windowMinutes"
	| "incidentId"
	| "incidentStatus"
	| "dedupeKey"
	| "template"
	| "sentAtMs"
>

/**
 * Build the flat `{{ variable }}` context for templated notifications. Every
 * value is a pre-formatted string, reusing the same helpers the hardcoded
 * formatters use, so templated and default output stay consistent.
 */
export const buildTemplateContext = (
	context: TemplateRenderContext,
	linkUrl: string,
	chatUrl: string,
): TemplateContext => ({
	"rule.name": context.ruleName,
	"rule.id": context.ruleId,
	"event.type": context.eventType,
	"event.label": formatEventTypeLabel(context.eventType),
	"event.emoji": eventTypeEmoji(context.eventType),
	severity: context.severity,
	signal: context.signalType,
	"signal.label": formatSignalLabel(context.signalType),
	"comparator.label": formatComparator(context.comparator),
	threshold: formatSignalMetric(context.threshold, context.signalType),
	thresholdUpper:
		context.thresholdUpper != null ? formatSignalMetric(context.thresholdUpper, context.signalType) : "",
	value: formatSignalMetric(context.value, context.signalType),
	observed: formatSignalMetric(context.value, context.signalType),
	"observed.summary": formatObservedSummary(context),
	sampleCount: context.sampleCount != null ? String(context.sampleCount) : "",
	group: context.groupKey ?? "all",
	window: formatWindow(context.windowMinutes),
	incidentId: context.incidentId ?? "",
	incidentStatus: context.incidentStatus,
	dedupeKey: context.dedupeKey,
	"links.app": linkUrl,
	linkUrl,
	"links.chat": chatUrl,
	chatUrl,
	sentAt: context.sentAtMs != null ? new Date(context.sentAtMs).toISOString() : "",
})

/** Minimal Markdown → Slack mrkdwn transform: `**b**`→`*b*`, `[t](url)`→`<url|t>`. */
const markdownToSlackMrkdwn = (markdown: string): string =>
	markdown.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")

const truncate = (value: string, max: number): string =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value

// Best-effort read of a provider's error response body for diagnostics. Only runs
// on the failure path; the body is unread in every `!response.ok` branch today.
const readErrorBody = (response: Response): Effect.Effect<string> =>
	Effect.promise(() => response.text().catch(() => "")).pipe(
		Effect.map((body) => truncate(body.trim().replace(/\s+/g, " "), 500)),
	)

/**
 * A PagerDuty Events API v2 integration ("routing") key is exactly 32
 * alphanumeric characters. A REST API token — the usual wrong paste — is shorter
 * and may contain `+`/`_`/`-`, so the length+charset check alone rejects it.
 */
export const PAGERDUTY_ROUTING_KEY_PATTERN = /^[A-Za-z0-9]{32}$/

export type PagerDutyKeyVerification =
	| { status: "valid" }
	| { status: "invalid"; reason: string }
	/** Network error / timeout / 429 / 5xx — can't conclude; caller should fail open. */
	| { status: "unknown" }

/**
 * Verify a PagerDuty routing key actually works by enqueuing a no-op `resolve`
 * event. PagerDuty validates the routing key before the action, so a valid key
 * returns 2xx (resolving an unknown dedup_key creates no incident and pages no
 * one) and an invalid key returns 400 "Invalid routing key". Never fails — any
 * transport/ambiguous response collapses to `unknown` so the caller owns policy.
 */
export const verifyPagerDutyRoutingKey = (
	integrationKey: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	dedupKey: string,
): Effect.Effect<PagerDutyKeyVerification> =>
	runTimedFetch("pagerduty", "PagerDuty", fetchFn, timeoutMs, () =>
		fetchFn("https://events.pagerduty.com/v2/enqueue", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				routing_key: integrationKey,
				event_action: "resolve",
				dedup_key: dedupKey,
			}),
		}),
	).pipe(
		Effect.flatMap((response) => {
			if (response.ok) return Effect.succeed<PagerDutyKeyVerification>({ status: "valid" })
			if (response.status === 400) {
				return readErrorBody(response).pipe(
					Effect.map(
						(reason): PagerDutyKeyVerification => ({
							status: "invalid",
							reason: reason || "Invalid routing key",
						}),
					),
				)
			}
			return Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" })
		}),
		Effect.catch(() => Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" })),
	)

/**
 * Resolve + render the effective title/body for a destination. Returns `null`
 * when the rule has no custom template (caller falls back to the hardcoded
 * formatter) or when rendering fails for any reason — templating must never
 * block delivery.
 */
const renderTitleBody = (
	context: TemplateRenderContext,
	destinationType: AlertDestinationType,
	linkUrl: string,
	chatUrl: string,
): { title: string; body: string } | null => {
	const resolved = resolveTemplate(context.template, destinationType)
	if (!hasCustomTemplate(resolved)) return null
	try {
		const templateCtx = buildTemplateContext(context, linkUrl, chatUrl)
		const title =
			renderTemplate(resolved.title ?? DEFAULT_TITLE_TEMPLATE, templateCtx).text.trim() ||
			context.ruleName
		const body = renderTemplate(resolved.body ?? DEFAULT_BODY_TEMPLATE, templateCtx).text
		return { title, body }
	} catch {
		return null
	}
}

export const buildSlackBlocksFromTemplate = (
	title: string,
	body: string,
	context: Pick<DispatchContext, "eventType">,
	linkUrl: string,
	chatUrl: string,
) => [
	{
		type: "header",
		text: { type: "plain_text", text: truncate(title, 150), emoji: true },
	},
	{
		type: "section",
		text: { type: "mrkdwn", text: markdownToSlackMrkdwn(body) },
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

export const buildDiscordEmbedsFromTemplate = (
	title: string,
	body: string,
	context: Pick<DispatchContext, "eventType" | "severity">,
	linkUrl: string,
	chatUrl: string,
) => [
	{
		title: truncate(title, 256),
		url: linkUrl,
		color: discordEmbedColor(context.eventType, context.severity),
		description: truncate(body, 4096),
		fields: [
			{
				name: "Links",
				value: `[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`,
				inline: false,
			},
		],
		footer: { text: "\u{1F341} Maple Alerts" },
	},
]

export interface DispatchDeps {
	/**
	 * Sends one email via the platform email channel (Cloudflare `EMAIL`
	 * binding). Injected like `fetchFn` so this module stays dependency-free.
	 */
	readonly sendEmail: (to: string, subject: string, html: string) => Effect.Effect<void, AlertDeliveryError>
}

export const dispatchDelivery = (
	context: DispatchContext,
	payloadJson: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	linkUrl: string,
	chatUrl: string,
	deps: DispatchDeps,
): Effect.Effect<DispatchResult, AlertDeliveryError> =>
	Effect.gen(function* () {
		return yield* Match.value(context.secretConfig).pipe(
			Match.discriminatorsExhaustive("type")({
				slack: (config) =>
					Effect.gen(function* () {
						const templated = renderTitleBody(context, "slack", linkUrl, chatUrl)
						const blocks = templated
							? buildSlackBlocksFromTemplate(
									templated.title,
									templated.body,
									context,
									linkUrl,
									chatUrl,
								)
							: buildSlackBlocks(context, linkUrl, chatUrl)
						const response = yield* runTimedFetch("slack", "Slack", fetchFn, timeoutMs, () =>
							safeFetch(config.webhookUrl, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									text:
										templated?.title ??
										`${context.ruleName}: ${formatEventTypeLabel(context.eventType)}`,
									attachments: [
										{
											color: slackAttachmentColor(context.eventType, context.severity),
											blocks,
										},
									],
								}),
								fetchFn,
							}),
						)
						if (!response.ok) {
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`Slack delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
									"slack",
								),
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
						const templated = renderTitleBody(context, "pagerduty", linkUrl, chatUrl)
						const body = {
							routing_key: config.integrationKey,
							event_action: context.eventType === "resolve" ? "resolve" : "trigger",
							dedup_key: context.dedupeKey,
							payload: {
								summary: truncate(
									templated?.title ?? `${context.ruleName} ${context.eventType}`,
									1024,
								),
								source: context.groupKey ?? "maple-alerts",
								severity: context.severity === "critical" ? "critical" : "warning",
								custom_details: {
									...(templated ? { message: templated.body } : {}),
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
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`PagerDuty delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
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
							safeFetch(config.url, { method: "POST", headers, body: payloadJson, fetchFn }),
						)
						if (!response.ok) {
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`Webhook delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
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
							safeFetch(config.webhookUrl, {
								method: "POST",
								headers,
								body: payloadJson,
								fetchFn,
							}),
						)
						if (!response.ok) {
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`Hazel delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
									"hazel",
								),
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
							template: context.template ?? null,
							linkUrl,
							chatUrl,
							sentAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
						})
						const response = yield* runTimedFetch(
							"hazel-oauth",
							"Hazel",
							fetchFn,
							timeoutMs,
							() =>
								safeFetch(hazelUrl, {
									method: "POST",
									headers: {
										"content-type": "application/json",
										"x-maple-event-type": context.eventType,
										"x-maple-delivery-key": context.deliveryKey,
									},
									body,
									fetchFn,
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
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`Hazel delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
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
				discord: (config) =>
					Effect.gen(function* () {
						const templated = renderTitleBody(context, "discord", linkUrl, chatUrl)
						const embeds = templated
							? buildDiscordEmbedsFromTemplate(
									templated.title,
									templated.body,
									context,
									linkUrl,
									chatUrl,
								)
							: buildDiscordEmbeds(context, linkUrl, chatUrl)
						const response = yield* runTimedFetch("discord", "Discord", fetchFn, timeoutMs, () =>
							safeFetch(config.webhookUrl, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									username: "Maple Alerts",
									content:
										templated?.title ??
										`**${context.ruleName}**: ${formatEventTypeLabel(context.eventType)}`,
									embeds,
								}),
								fetchFn,
							}),
						)
						if (!response.ok) {
							const detail = yield* readErrorBody(response)
							return yield* Effect.fail(
								makeDeliveryError(
									`Discord delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
									"discord",
								),
							)
						}
						return {
							providerMessage: "Delivered to Discord",
							providerReference: null,
							responseCode: response.status,
						} as DispatchResult
					}),
				email: (config) =>
					Effect.gen(function* () {
						const { subject, html } = yield* buildAlertEmailContent(context, linkUrl, chatUrl)
						yield* Effect.forEach(
							config.members,
							(member) => deps.sendEmail(member.email, subject, html),
							{ discard: true },
						)
						const count = config.members.length
						return {
							providerMessage: `Emailed ${count} member${count === 1 ? "" : "s"}`,
							providerReference: null,
							responseCode: null,
						} as DispatchResult
					}),
			}),
		)
	})
