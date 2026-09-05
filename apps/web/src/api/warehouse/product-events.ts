// Product-event queries over `product_events`: the event-name list the funnel
// step builder autocompletes from, and the dashboard funnel widget's own
// step-based conversion query. See
// packages/query-engine/src/ch/queries/product-events.ts for the semantics of
// `keyBy`, the session step, and the breakdown grouping.

import { Effect, Schema } from "effect"
import { TraceId } from "@maple/domain"
import {
	ProductEventNamesRequest,
	ProductEventsForTraceRequest,
	ProductEventsFunnelBreakdownRequest,
	ProductEventsFunnelRequest,
	ProductEventTraceSamplesRequest,
} from "@maple/domain/http"
import {
	FUNNEL_WIDGET_BREAKDOWN_LIMIT,
	ProductEventsFunnelWidgetParams,
	funnelWidgetBreakdownRows,
	funnelWidgetRows,
	type FunnelWidgetRow,
} from "@maple/query-model"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { TimeWindowFields, WebAnalyticsFilterFields } from "@/api/warehouse/web-analytics"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const ProductEventNamesInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	limit: Schema.optional(PositiveInt),
})

export type GetProductEventNamesInput = (typeof ProductEventNamesInputSchema)["Encoded"]

export interface ProductEventName {
	eventName: string
	/** `navigation` for page views, `custom` for `track()` calls, `screen` for mobile screens. */
	kind: string
	count: number
	sessions: number
	persons: number
}

export function getProductEventNames({ data }: { data: GetProductEventNamesInput }) {
	return getProductEventNamesEffect({ data })
}

const getProductEventNamesEffect = Effect.fn("QueryEngine.getProductEventNames")(function* ({
	data,
}: {
	data: GetProductEventNamesInput
}) {
	const input = yield* decodeInput(ProductEventNamesInputSchema, data, "getProductEventNames")

	const result = yield* runWarehouseQuery("productEventNames", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.productEventNames({
				payload: new ProductEventNamesRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<ProductEventName> }
})

// Trace ↔ product event: an annotated span becomes a `product_events` row carrying
// its `TraceId`, and these two read that column from either end. `TraceId`, not a
// plain string, so a malformed id fails at `decodeInput` rather than the warehouse.
const ProductEventsForTraceInputSchema = Schema.Struct({
	...TimeWindowFields,
	traceId: TraceId,
	limit: Schema.optional(PositiveInt),
})

export type GetProductEventsForTraceInput = (typeof ProductEventsForTraceInputSchema)["Encoded"]

export interface TraceProductEvent {
	timestamp: string
	eventName: string
	/** The annotated span within the trace — deep-links to it in the waterfall. */
	spanId: string
	serviceName: string
	userId: string
	groupId: string
	visitorId: string
	sessionId: string
	/** The span's attributes as projected by `maple.product_event.include` / `prop.*`. */
	attributes: Record<string, string>
}

export function getProductEventsForTrace({ data }: { data: GetProductEventsForTraceInput }) {
	return getProductEventsForTraceEffect({ data })
}

const getProductEventsForTraceEffect = Effect.fn("QueryEngine.getProductEventsForTrace")(function* ({
	data,
}: {
	data: GetProductEventsForTraceInput
}) {
	const input = yield* decodeInput(ProductEventsForTraceInputSchema, data, "getProductEventsForTrace")

	const result = yield* runWarehouseQuery("productEventsForTrace", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.productEventsForTrace({
				payload: new ProductEventsForTraceRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<TraceProductEvent> }
})

const ProductEventTraceSamplesInputSchema = Schema.Struct({
	...TimeWindowFields,
	eventName: Schema.String,
	limit: Schema.optional(PositiveInt),
})

export type GetProductEventTraceSamplesInput = (typeof ProductEventTraceSamplesInputSchema)["Encoded"]

export interface ProductEventTraceSample {
	traceId: string
	spanId: string
	timestamp: string
	serviceName: string
	userId: string
	visitorId: string
}

export function getProductEventTraceSamples({ data }: { data: GetProductEventTraceSamplesInput }) {
	return getProductEventTraceSamplesEffect({ data })
}

const getProductEventTraceSamplesEffect = Effect.fn("QueryEngine.getProductEventTraceSamples")(function* ({
	data,
}: {
	data: GetProductEventTraceSamplesInput
}) {
	const input = yield* decodeInput(ProductEventTraceSamplesInputSchema, data, "getProductEventTraceSamples")

	const result = yield* runWarehouseQuery("productEventTraceSamples", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.productEventTraceSamples({
				payload: new ProductEventTraceSamplesRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<ProductEventTraceSample> }
})

// Dashboard funnel widget (route data source `product_events_funnel`).
//
// The widget's stored `display.funnel` definition — steps, key, window, an
// optional breakdown and the flat population filters — is the route's params
// bag (`ProductEventsFunnelWidgetParams`); the dashboard planner adds
// `startTime`/`endTime`. The rows come back as `{ name, value }` (plus `group`
// on a breakdown) so the same funnel chart the group-by breakdown feeds draws
// them unchanged: one bar per step, or one per group per step.

const ProductEventsFunnelWidgetInputSchema = Schema.Struct({
	...TimeWindowFields,
	...ProductEventsFunnelWidgetParams.fields,
})

export type GetProductEventsFunnelWidgetInput = (typeof ProductEventsFunnelWidgetInputSchema)["Encoded"]

/** The default key and window a widget without them runs with. */
const WIDGET_DEFAULT_KEY_BY = "person"
const WIDGET_DEFAULT_WINDOW_SECONDS = 24 * 3600

export function getProductEventsFunnelWidget({ data }: { data: GetProductEventsFunnelWidgetInput }) {
	return getProductEventsFunnelWidgetEffect({ data })
}

const getProductEventsFunnelWidgetEffect = Effect.fn("QueryEngine.getProductEventsFunnelWidget")(function* ({
	data,
}: {
	data: GetProductEventsFunnelWidgetInput
}) {
	const input = yield* decodeInput(
		ProductEventsFunnelWidgetInputSchema,
		data,
		"getProductEventsFunnelWidget",
	)

	// A funnel with no steps yet (the preset tile, a widget mid-edit) draws the
	// empty state rather than asking the warehouse for a definition it rejects.
	if (input.steps.length === 0) return { data: [] satisfies ReadonlyArray<FunnelWidgetRow> }

	const { breakdownBy, ...rest } = input
	const request = {
		...rest,
		keyBy: input.keyBy ?? WIDGET_DEFAULT_KEY_BY,
		windowSeconds: input.windowSeconds ?? WIDGET_DEFAULT_WINDOW_SECONDS,
	}

	if (breakdownBy !== undefined) {
		const result = yield* runWarehouseQuery("productEventsFunnelWidgetBreakdown", () =>
			Effect.gen(function* () {
				const client = yield* MapleInternalAtomClient
				return yield* client.queryEngine.productEventsFunnelBreakdown({
					payload: new ProductEventsFunnelBreakdownRequest({
						...request,
						breakdownBy,
						limit: FUNNEL_WIDGET_BREAKDOWN_LIMIT,
					}),
				})
			}),
		)
		return { data: funnelWidgetBreakdownRows(input.steps, result.data) }
	}

	const result = yield* runWarehouseQuery("productEventsFunnelWidget", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.productEventsFunnel({
				payload: new ProductEventsFunnelRequest(request),
			})
		}),
	)
	return { data: funnelWidgetRows(input.steps, result.data) }
})
