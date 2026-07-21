import { Schema } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

export type AlertSignalType =
	| "error_rate"
	| "p95_latency"
	| "p99_latency"
	| "apdex"
	| "throughput"
	| "metric"
	| "builder_query"
	| "raw_query"

export type AlertComparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between" | "not_between"

/**
 * Alert rule props, authored in the v2 wire shape — mirrors
 * `POST /v2/alerts/rules`. Signal-specific fields (`metric_*`,
 * `apdex_threshold_ms`, `query_builder_draft`, `raw_query_*`) are validated
 * server-side against `signal_type`.
 */
export interface AlertRuleProps {
	/** Rule name — unique per organization. */
	name: string
	severity: "warning" | "critical"
	signal_type: AlertSignalType
	comparator: AlertComparator
	/** Error rates are 0–1 ratios. */
	threshold: number
	window_minutes: number
	/** `dest_…` IDs — pass `destination.destinationId` outputs from `Maple.AlertDestination`. */
	destination_ids: string[]
	notes?: string | null
	enabled?: boolean
	service_names?: string[]
	exclude_service_names?: string[]
	tags?: string[]
	group_by?: string[] | null
	threshold_upper?: number | null
	minimum_sample_count?: number
	consecutive_breaches_required?: number
	consecutive_healthy_required?: number
	renotify_interval_minutes?: number
	metric_name?: string | null
	metric_type?: "sum" | "gauge" | "histogram" | "exponential_histogram" | null
	metric_aggregation?: "avg" | "min" | "max" | "sum" | "count" | null
	apdex_threshold_ms?: number | null
	/** Opaque query-builder draft for `builder_query` rules (verbatim passthrough). */
	query_builder_draft?: Record<string, unknown> | null
	raw_query_sql?: string | null
	raw_query_reducer?: "identity" | "sum" | "avg" | "min" | "max" | null
	notification_template?: Record<string, unknown> | null
}

export type AlertRule = Resource<
	"Maple.AlertRule",
	AlertRuleProps,
	{
		/** The `alrt_…` public ID. */
		ruleId: string
		name: string
		enabled: boolean
	},
	never,
	Providers
>

/**
 * A Maple alert rule managed through the public v2 API. Reference the
 * destinations it notifies by their `dest_…` IDs — typically outputs of
 * `Maple.AlertDestination` resources, which Alchemy resolves and orders
 * automatically.
 *
 * @example
 * ```typescript
 * const slack = yield* Maple.AlertDestination("oncall", { ... })
 * yield* Maple.AlertRule("checkout-errors", {
 *   name: "Checkout error rate",
 *   severity: "critical",
 *   signal_type: "error_rate",
 *   comparator: "gt",
 *   threshold: 0.05,
 *   window_minutes: 5,
 *   destination_ids: [slack.destinationId],
 * })
 * ```
 */
export const AlertRule = Resource<AlertRule>("Maple.AlertRule")

const WireRule = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
})
const decodeWireRule = Schema.decodeUnknownEffect(WireRule)

/** The create/update body: exactly the props the user declared. */
const desiredBody = (props: AlertRuleProps): Record<string, unknown> => {
	const body: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined) body[key] = value
	}
	return body
}

/** Wire drift compare: declared fields vs the observed wire rule. */
const drifted = (props: AlertRuleProps, observed: Record<string, unknown>): boolean => {
	const body = desiredBody(props)
	return Object.keys(body).some((key) => !deepEqual(body[key], observed[key], { stripNullish: true }))
}

const toAttributes = (observed: Schema.Schema.Type<typeof WireRule>) => ({
	ruleId: observed.id,
	name: observed.name,
	enabled: observed.enabled,
})

export const AlertRuleProvider = () =>
	Provider.effect(
		AlertRule,
		Effect.gen(function* () {
			const api = yield* MapleApi

			/** Rule names are org-unique — adopt an existing rule with the same name. */
			const findByName = (name: string) =>
				Effect.gen(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					const match = items.find(
						(item) => typeof item === "object" && item !== null && (item as { name?: unknown }).name === name,
					)
					return match === undefined ? undefined : yield* decodeWireRule(match)
				})

			return {
				stables: ["ruleId" as const],
				diff: Effect.fn(function* ({ news, olds }) {
					if (!isResolved(news)) return undefined
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["ruleId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, output }) {
					// Observe — re-fetch by id, falling back to the org-unique name so we
					// recover from partial state-persistence failures without duplicating.
					let observedRaw: unknown
					if (output?.ruleId) {
						observedRaw = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
					}
					if (observedRaw === undefined) {
						const adopted = yield* findByName(news.name)
						if (adopted !== undefined) {
							observedRaw = yield* api.get(`/v2/alerts/rules/${adopted.id}`)
						}
					}

					// Ensure — create if missing.
					if (observedRaw === undefined) {
						observedRaw = yield* api.post("/v2/alerts/rules", desiredBody(news))
					} else if (drifted(news, observedRaw as Record<string, unknown>)) {
						// Sync — PATCH only on drift of declared fields.
						const current = yield* decodeWireRule(observedRaw)
						observedRaw = yield* api.patch(`/v2/alerts/rules/${current.id}`, desiredBody(news))
					}

					return toAttributes(yield* decodeWireRule(observedRaw))
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/alerts/rules/${output.ruleId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.void))
				}),
				read: Effect.fn(function* ({ olds, output }) {
					if (output?.ruleId) {
						const fetched = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
						if (fetched !== undefined) return toAttributes(yield* decodeWireRule(fetched))
					}
					if (olds?.name !== undefined) {
						const adopted = yield* findByName(olds.name)
						if (adopted !== undefined) return toAttributes(adopted)
					}
					return undefined
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					return yield* Effect.forEach(items, (item) => Effect.map(decodeWireRule(item), toAttributes))
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _alertRuleCreateBody = desiredBody
