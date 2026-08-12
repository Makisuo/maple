import { createHmac } from "node:crypto"
import {
	AlertDeliveryError,
	type AlertComparator,
	type AlertDestinationType,
	type AlertEventType,
	type OrgId,
	type AlertSignalType,
	type AlertSeverity,
} from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/db"
import { Clock, Duration, Effect, Match, Schema } from "effect"
import type { EnrichedDestinationSecretConfig } from "./AlertDestinationHydration"
import { safeFetch } from "@/http/url-validator"
import { buildAlertEmailContent } from "./alert-email"
import {
	comparatorBreachPhrase,
	discordEmbedColor,
	eventTypeEmoji,
	formatComparator,
	formatEventTypeLabel,
	formatObservedSummary,
	formatSeverityLabel,
	formatSignalLabel,
	formatSignalMetric,
	formatThresholdSummary,
	formatWindow,
	severityEmoji,
	slackAttachmentColor,
	type TemplateRenderContext,
} from "./alert-formatting"
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
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

const makeDeliveryError = (message: string, destinationType?: AlertDestinationType, cause?: unknown) =>
	new AlertDeliveryError({ message, destinationType, ...(cause === undefined ? {} : { cause }) })

/**
 * Slack Web API `chat.postMessage` response envelope. Slack returns HTTP 200
 * with `{ ok: false, error }` on logical failures, so the body is the source
 * of truth.
 */
const SlackPostMessageResponseSchema = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	error: Schema.optionalKey(Schema.String),
	ts: Schema.optionalKey(Schema.String),
})
const decodeSlackPostMessageResponse = Schema.decodeUnknownEffect(SlackPostMessageResponseSchema)

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
				error,
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

/**
 * Escape Slack mrkdwn control characters in dynamic text (Slack parses `<...>`
 * as link/mention syntax). Required by https://docs.slack.dev/messaging/formatting-message-text
 * for any user-controlled value interpolated into mrkdwn.
 */
const escapeSlackMrkdwn = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * One human-readable sentence describing what happened — the message lead, per
 * Slack's Block Kit guidance (header as subject line, then a short clear
 * sentence, with details relegated to fields/context).
 */
const buildSlackSummaryLine = (
	context: Pick<
		DispatchContext,
		"eventType" | "signalType" | "comparator" | "threshold" | "thresholdUpper" | "value" | "windowMinutes"
	>,
): string => {
	const signal = formatSignalLabel(context.signalType)
	const observed = formatSignalMetric(context.value, context.signalType)
	const window = formatWindow(context.windowMinutes)
	if (context.eventType === "test") {
		return `This is a test notification. Live alerts fire when *${signal}* is ${comparatorBreachPhrase(context)} over a ${window} window.`
	}
	if (context.eventType === "resolve") {
		const now = context.value != null ? ` — now *${observed}*` : ""
		return `*${signal}* is back within its threshold (${formatThresholdSummary(context)})${now}.`
	}
	return `*${signal}* is *${observed}* — ${comparatorBreachPhrase(context)}, measured over the last ${window}.`
}

const buildSlackActionsBlock = (linkUrl: string, chatUrl: string) => ({
	type: "actions",
	elements: [
		{
			type: "button",
			text: { type: "plain_text", text: "Open in Maple", emoji: true },
			url: linkUrl,
			style: "primary",
		},
		{
			type: "button",
			text: { type: "plain_text", text: "✨ Ask Maple AI", emoji: true },
			url: chatUrl,
		},
	],
})

/**
 * Footer: brand + incident reference + a `<!date^…>` timestamp so Slack renders
 * the fire time in each viewer's local timezone (ISO fallback for exports).
 */
const buildSlackContextBlock = (context: Pick<DispatchContext, "sentAtMs" | "incidentId">) => {
	const parts = ["\u{1F341} Maple Alerts"]
	if (context.incidentId) parts.push(`Incident \`${escapeSlackMrkdwn(context.incidentId)}\``)
	if (context.sentAtMs != null) {
		const seconds = Math.floor(context.sentAtMs / 1000)
		const iso = new Date(context.sentAtMs).toISOString()
		parts.push(`<!date^${seconds}^{date_short_pretty} at {time}|${iso}>`)
	}
	return { type: "context", elements: [{ type: "mrkdwn", text: parts.join("  ·  ") }] }
}

export const buildSlackBlocks = (context: TemplateRenderContext, linkUrl: string, chatUrl: string) => [
	{
		type: "header",
		text: {
			type: "plain_text",
			text: truncate(
				`${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
				150,
			),
			emoji: true,
		},
	},
	{
		type: "section",
		text: { type: "mrkdwn", text: buildSlackSummaryLine(context) },
		fields: [
			{
				type: "mrkdwn",
				text: `*Severity*\n${severityEmoji(context.severity)} ${formatSeverityLabel(context.severity)}`,
			},
			...(context.groupKey != null
				? [{ type: "mrkdwn", text: `*Group*\n\`${escapeSlackMrkdwn(context.groupKey)}\`` }]
				: []),
		],
	},
	buildSlackActionsBlock(linkUrl, chatUrl),
	buildSlackContextBlock(context),
]

/**
 * Notification-preview fallback (`text` alongside blocks): a complete one-line
 * summary, since push/desktop previews render only this string.
 */
export const buildSlackFallbackText = (context: TemplateRenderContext): string =>
	`${eventTypeEmoji(context.eventType)} ${escapeSlackMrkdwn(context.ruleName)} — ${formatEventTypeLabel(context.eventType)} · ${formatSignalLabel(context.signalType)} ${formatObservedSummary(context)}`

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

/**
 * Minimal Markdown → Slack mrkdwn transform: `**b**`→`*b*`, `[t](url)`→`<url|t>`.
 *
 * The body is a user-authored notification template, so it is escaped BEFORE the
 * rewrites: every `<…>` the author typed becomes literal text, which neutralizes
 * `<!channel>`/`<!here>`/`<!everyone>` broadcasts (the slack-bot destination holds
 * `chat:write.public` and can post to any public channel) and hand-written
 * deceptive links like `<https://evil.test|Open in Maple>`. Only the `<…>` this
 * function builds itself reaches Slack as markup. Slack decodes `&amp;`/`&lt;`/
 * `&gt;` for display, so legitimate text and `&`-bearing URLs survive intact.
 */
const markdownToSlackMrkdwn = (markdown: string): string =>
	escapeSlackMrkdwn(markdown)
		.replace(/\*\*([^*]+)\*\*/g, "*$1*")
		.replace(
			/\[([^\]]+)\]\(([^)]+)\)/g,
			// `|` would otherwise end the link target and let the rest of the URL pose
			// as the label.
			(_match, text: string, url: string) => `<${url.replaceAll("|", "%7C")}|${text}>`,
		)

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
		Effect.orElseSucceed(() => ({ status: "unknown" as const })),
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
	context: Pick<DispatchContext, "eventType" | "sentAtMs" | "incidentId">,
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
	buildSlackActionsBlock(linkUrl, chatUrl),
	buildSlackContextBlock(context),
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
	/**
	 * Resolves the decrypted Slack bot token for an org from its
	 * `slack_workspaces` row. Injected like `sendEmail` so this module stays
	 * dependency-free — only the `slack-bot` destination arm invokes it. Fails
	 * (AlertDeliveryError) when the org has no active Slack installation.
	 */
	readonly resolveSlackBotToken: (orgId: OrgId) => Effect.Effect<string, AlertDeliveryError>
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
	Match.value(context.secretConfig).pipe(
		Match.discriminatorsExhaustive("type")({
			"slack-bot": (config) =>
				Effect.gen(function* () {
					const botToken = yield* deps.resolveSlackBotToken(context.destination.orgId)
					const templated = renderTitleBody(context, "slack-bot", linkUrl, chatUrl)
					const blocks = templated
						? buildSlackBlocksFromTemplate(
								templated.title,
								templated.body,
								context,
								linkUrl,
								chatUrl,
							)
						: buildSlackBlocks(context, linkUrl, chatUrl)
					const response = yield* runTimedFetch("slack-bot", "Slack", fetchFn, timeoutMs, () =>
						fetchFn("https://slack.com/api/chat.postMessage", {
							method: "POST",
							headers: {
								"content-type": "application/json; charset=utf-8",
								authorization: `Bearer ${botToken}`,
							},
							body: JSON.stringify({
								channel: config.channelId,
								// Blocks ride inside a colored attachment so the message
								// carries the severity color bar — same as the webhook
								// destination (the bar has no Block Kit equivalent). No
								// top-level `text`: alongside attachments Slack renders it
								// as a duplicate line above the bar; `fallback` carries
								// the notification-preview one-liner instead.
								attachments: [
									{
										color: slackAttachmentColor(context.eventType, context.severity),
										fallback: templated?.title ?? buildSlackFallbackText(context),
										blocks,
									},
								],
							}),
						}),
					)
					if (!response.ok) {
						const detail = yield* readErrorBody(response)
						return yield* Effect.fail(
							makeDeliveryError(
								`Slack delivery failed with ${response.status}${detail ? `: ${detail}` : ""}`,
								"slack-bot",
							),
						)
					}
					// Slack Web API returns HTTP 200 with `{ ok: false, error }` on
					// logical failures, so the JSON body — not the status — is the
					// source of truth.
					const rawPayload = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: (error) =>
							makeDeliveryError("Slack returned a non-JSON response", "slack-bot", error),
					})
					const payload = yield* decodeSlackPostMessageResponse(rawPayload).pipe(
						Effect.mapError((error) =>
							makeDeliveryError(
								`Slack returned an unexpected response payload: ${error.message}`,
								"slack-bot",
							),
						),
					)
					if (!payload.ok) {
						const error = payload.error ?? "unknown_error"
						// HTTP 200 + `ok:false` is the dominant operational failure here
						// (`not_in_channel` after a rename/kick). NotificationDispatcher
						// only records outcome "failed", so annotate the Slack error code
						// on the span to make it aggregatable.
						yield* Effect.annotateCurrentSpan({
							"maple.delivery.destination_type": "slack-bot",
							"maple.delivery.provider_error": error,
						})
						const message =
							error === "not_in_channel" || error === "channel_not_found"
								? `Slack rejected the message (${error}) — invite the Maple bot to the channel and try again`
								: `Slack rejected the message: ${error}`
						return yield* Effect.fail(makeDeliveryError(message, "slack-bot"))
					}
					return {
						providerMessage: `Delivered to Slack #${config.channelName ?? config.channelId}`,
						providerReference: payload.ts ?? null,
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
					const response = yield* runTimedFetch("pagerduty", "PagerDuty", fetchFn, timeoutMs, () =>
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
					const response = yield* runTimedFetch("hazel-oauth", "Hazel", fetchFn, timeoutMs, () =>
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
					const outcomes = yield* Effect.forEach(config.members, (member) =>
						deps.sendEmail(member.email, subject, html).pipe(
							Effect.match({
								onSuccess: () => ({ member, error: null as string | null }),
								onFailure: (error) => ({ member, error: error.message }),
							}),
						),
					)
					const failures = outcomes.filter((o) => o.error != null)
					const count = config.members.length

					if (failures.length === count && count > 0) {
						// Nobody received the email — safe to fail retryable; the retry
						// re-sends to members who all got nothing. Keep the first failure
						// message verbatim so timeout classification survives aggregation.
						return yield* Effect.fail(
							makeDeliveryError(
								`Email delivery failed for all ${count} member${count === 1 ? "" : "s"}: ${failures[0]!.error}`,
								"email",
							),
						)
					}

					if (failures.length > 0) {
						// Partial success is terminal: there is no per-member attempt
						// state, so retrying the event would re-email the members who
						// already received it. Report success and surface the failures.
						yield* Effect.logWarning("Alert email delivered to a subset of members").pipe(
							Effect.annotateLogs({
								failedCount: failures.length,
								memberCount: count,
								firstError: failures[0]!.error,
							}),
						)
						return {
							providerMessage: `Emailed ${count - failures.length} of ${count} members; failed: ${failures
								.map((f) => `${f.member.email} (${f.error})`)
								.join(", ")}`,
							providerReference: null,
							responseCode: null,
						} as DispatchResult
					}

					return {
						providerMessage: `Emailed ${count} member${count === 1 ? "" : "s"}`,
						providerReference: null,
						responseCode: null,
					} as DispatchResult
				}),
		}),
	)
