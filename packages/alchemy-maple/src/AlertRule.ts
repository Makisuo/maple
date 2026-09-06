import { Schema } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import { Unowned } from "alchemy/AdoptPolicy"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import { MapleErrorTags } from "./errors"
import type { Providers } from "./Providers"
import {
	canAdoptRule,
	ownershipError,
	ownershipTags,
	ownsRule,
	ruleOwnerTags,
	ruleTags,
} from "./AlertRuleOwnership"

export type AlertSignalType =
	| "error_rate"
	| "p95_latency"
	| "p99_latency"
	| "apdex"
	| "throughput"
	| "builder_query"
	| "raw_query"

export type AlertComparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between" | "not_between"

/**
 * Alert rule props, authored in the v2 wire shape — mirrors
 * `POST /v2/alerts/rules`. Signal-specific fields (`apdex_threshold_ms`,
 * `query_builder_draft`, `raw_query_*`) are validated
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
	/** Up to 19 user tags; `alchemy:` tags are reserved for stack ownership. */
	tags?: string[]
	group_by?: string[] | null
	threshold_upper?: number | null
	minimum_sample_count?: number
	consecutive_breaches_required?: number
	consecutive_healthy_required?: number
	renotify_interval_minutes?: number
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
		/** Observed declared fields and ownership tags, used by Alchemy sync. */
		configuration?: Record<string, unknown>
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

const WireRule = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		enabled: Schema.Boolean,
		tags: Schema.Array(Schema.String),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)
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
const drifted = (body: Record<string, unknown>, observed: Record<string, unknown>): boolean => {
	return Object.keys(body).some((key) => !deepEqual(body[key], observed[key], { stripNullish: true }))
}

const toAttributes = (observed: Schema.Schema.Type<typeof WireRule>, props?: AlertRuleProps) => ({
	ruleId: observed.id,
	name: observed.name,
	enabled: observed.enabled,
	configuration: {
		...Object.fromEntries(
			Object.keys(props ? desiredBody(props) : {}).map((key) => [key, observed[key]]),
		),
		// Observe ownership even when the user leaves ordinary tags unmanaged.
		tags: props?.tags === undefined ? ownershipTags(observed.tags) : observed.tags,
	},
})

export const AlertRuleProvider = () =>
	Provider.effect(
		AlertRule,
		Effect.gen(function* () {
			const api = yield* MapleApi

			/** A name locates a candidate; its ownership tags decide whether it is ours. */
			const findByName = (name: string) =>
				Effect.gen(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					const match = items.find(
						(item) =>
							typeof item === "object" &&
							item !== null &&
							(item as { name?: unknown }).name === name,
					)
					return match === undefined ? undefined : yield* decodeWireRule(match)
				})

			return {
				stables: ["ruleId" as const],
				diff: Effect.fn(function* ({ news, olds, output }) {
					// Add snapshots and ownership to resources from pre-tag releases.
					if (output && output.configuration === undefined) return { action: "update" } as const
					if (!isResolved(news)) return undefined
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["ruleId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, output, fqn }) {
					const owners = yield* ruleOwnerTags(fqn)
					let observedRaw: unknown
					if (output?.ruleId) {
						observedRaw = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
					}
					if (observedRaw === undefined) {
						const adopted = yield* findByName(news.name)
						if (adopted !== undefined) {
							observedRaw = yield* api.get(`/v2/alerts/rules/${adopted.id}`)
						}
					}

					const current = observedRaw === undefined ? undefined : yield* decodeWireRule(observedRaw)
					// Plan can skip read for unresolved upstream inputs; enforce ownership
					// here too, before any mutation or name-based recovery.
					if (current && !ownsRule(current.tags, owners, output?.ruleId === current.id)) {
						if (!(yield* canAdoptRule(fqn))) return yield* ownershipError(fqn, current.name)
					}
					const body = {
						...desiredBody(news),
						tags: yield* ruleTags(news.tags, current?.tags ?? [], owners[0]),
					}
					if (current === undefined) {
						observedRaw = yield* api.post("/v2/alerts/rules", body)
					} else if (drifted(body, current)) {
						observedRaw = yield* api.patch(`/v2/alerts/rules/${current.id}`, body)
					}

					return toAttributes(yield* decodeWireRule(observedRaw), news)
				}),
				delete: Effect.fn(function* ({ output, fqn, force }) {
					// A previous owner must not delete a rule another stack has adopted.
					if (!force) {
						const fetched = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
						if (fetched === undefined) return
						const current = yield* decodeWireRule(fetched)
						if (!ownsRule(current.tags, yield* ruleOwnerTags(fqn), true)) {
							return yield* ownershipError(fqn, current.name)
						}
					}
					yield* api
						.delete(`/v2/alerts/rules/${output.ruleId}`)
						.pipe(Effect.catchTag(MapleErrorTags.alertRuleNotFound, () => Effect.void))
				}),
				read: Effect.fn(function* ({ olds, output, fqn }) {
					const owners = yield* ruleOwnerTags(fqn)
					const attributes = (observed: Schema.Schema.Type<typeof WireRule>) => {
						const result = toAttributes(observed, olds)
						return ownsRule(observed.tags, owners, output?.ruleId === observed.id)
							? result
							: Unowned(result)
					}
					if (output?.ruleId) {
						const fetched = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
						if (fetched !== undefined) return attributes(yield* decodeWireRule(fetched))
					}
					if (olds?.name !== undefined) {
						const adopted = yield* findByName(olds.name)
						if (adopted !== undefined) return attributes(adopted)
					}
					return undefined
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireRule(item), (observed) => toAttributes(observed)),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _alertRuleCreateBody = desiredBody
