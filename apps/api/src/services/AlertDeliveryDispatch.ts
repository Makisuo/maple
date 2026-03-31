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

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface DestinationPublicConfig {
  readonly summary: string
  readonly channelLabel: string | null
}

type DestinationSecretConfig =
  | { readonly type: "slack"; readonly webhookUrl: string }
  | { readonly type: "pagerduty"; readonly integrationKey: string }
  | {
      readonly type: "webhook"
      readonly url: string
      readonly signingSecret: string | null
    }

export interface DispatchContext {
  readonly deliveryKey: string
  readonly destination: AlertDestinationRow
  readonly publicConfig: DestinationPublicConfig
  readonly secretConfig: DestinationSecretConfig
  readonly ruleId: string
  readonly ruleName: string
  readonly serviceName: string | null
  readonly signalType: AlertSignalType
  readonly severity: AlertSeverity
  readonly comparator: AlertComparator
  readonly threshold: number
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
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

const round = (value: number, decimals = 2): string => {
  const factor = 10 ** decimals
  return (Math.round(value * factor) / factor).toString()
}

export const formatComparator = (value: AlertComparator): string =>
  Match.value(value).pipe(
    Match.when("gt", () => ">"),
    Match.when("gte", () => ">="),
    Match.when("lt", () => "<"),
    Match.when("lte", () => "<="),
    Match.exhaustive,
  )

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

export const formatSignalMetric = (
  value: number | null,
  signalType: string,
): string =>
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

const slackAttachmentColor = (
  eventType: string,
  severity: string,
): string => {
  if (eventType === "resolve") return "#2eb67d"
  if (eventType === "test") return "#36c5f0"
  if (severity === "critical") return "#e01e5a"
  return "#ecb22e" // warning
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

const makeDeliveryError = (
  message: string,
  destinationType?: AlertDestinationType,
) =>
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
      onTimeout: () =>
        Effect.fail(
          makeDeliveryError(`${label} delivery timed out after ${timeoutMs}ms`, destinationType),
        ),
    }),
  )

const buildSlackBlocks = (context: DispatchContext, linkUrl: string) => [
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
      { type: "mrkdwn", text: `*Service*\n${context.serviceName ?? "All services"}` },
      {
        type: "mrkdwn",
        text: `*Observed*\n${formatSignalMetric(context.value, context.signalType)} ${formatComparator(context.comparator)} ${formatSignalMetric(context.threshold, context.signalType)}`,
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
                      blocks: buildSlackBlocks(context, linkUrl),
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
            return { providerMessage: "Delivered to Slack", providerReference: null, responseCode: response.status } as DispatchResult
          }),
        pagerduty: (config) =>
          Effect.gen(function* () {
            const body = {
              routing_key: config.integrationKey,
              event_action: context.eventType === "resolve" ? "resolve" : "trigger",
              dedup_key: context.dedupeKey,
              payload: {
                summary: `${context.ruleName} ${context.eventType}`,
                source: context.serviceName ?? "maple",
                severity: context.severity === "critical" ? "critical" : "warning",
                custom_details: {
                  ruleName: context.ruleName,
                  signalType: context.signalType,
                  value: context.value,
                  threshold: context.threshold,
                  comparator: context.comparator,
                  serviceName: context.serviceName,
                  linkUrl,
                },
              },
              links: [{ href: linkUrl, text: "Open in Maple" }],
            }
            const response = yield* runTimedFetch("pagerduty", "PagerDuty", fetchFn, timeoutMs, () =>
              fetchFn("https://events.pagerduty.com/v2/enqueue", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            )
            if (!response.ok) {
              return yield* Effect.fail(
                makeDeliveryError(`PagerDuty delivery failed with ${response.status}`, "pagerduty"),
              )
            }
            return { providerMessage: "Delivered to PagerDuty", providerReference: context.dedupeKey, responseCode: response.status } as DispatchResult
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
                makeDeliveryError(`Webhook delivery failed with ${response.status}`, "webhook"),
              )
            }
            return { providerMessage: "Delivered to webhook", providerReference: context.dedupeKey, responseCode: response.status } as DispatchResult
          }),
      }),
    )
  })
