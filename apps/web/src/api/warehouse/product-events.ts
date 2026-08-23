// Product-event funnels: the step-based conversion queries over
// `product_events`. Shares the web-analytics filter surface so the /analytics
// sidebar narrows a funnel exactly the way it narrows the page-view panels.
// See packages/query-engine/src/ch/queries/product-events.ts for the semantics
// of `keyBy`, the session step, and the breakdown grouping.

import { Effect, Schema } from "effect"
import {
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelStep,
	ProductEventNamesRequest,
	ProductEventsFunnelBreakdownRequest,
	ProductEventsFunnelRequest,
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

const ProductEventsFunnelInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	steps: Schema.Array(FunnelStep),
	keyBy: FunnelKeyBy,
	windowSeconds: PositiveInt,
})

const ProductEventsFunnelBreakdownInputSchema = Schema.Struct({
	...ProductEventsFunnelInputSchema.fields,
	breakdownBy: FunnelBreakdownBy,
	limit: Schema.optional(PositiveInt),
})

const ProductEventNamesInputSchema = Schema.Struct({
	...TimeWindowFields,
	...WebAnalyticsFilterFields,
	limit: Schema.optional(PositiveInt),
})

export type GetProductEventsFunnelInput = (typeof ProductEventsFunnelInputSchema)["Encoded"]
export type GetProductEventsFunnelBreakdownInput = (typeof ProductEventsFunnelBreakdownInputSchema)["Encoded"]
export type GetProductEventNamesInput = (typeof ProductEventNamesInputSchema)["Encoded"]

/** One funnel step's result, in step order. */
export interface FunnelStepCount {
	/** 1-based. */
	step: number
	count: number
}

export interface FunnelBreakdownRow {
	group: string
	step: number
	count: number
}

export interface ProductEventName {
	eventName: string
	/** `navigation` for page views, `custom` for `track()` calls, `screen` for mobile screens. */
	kind: string
	count: number
	sessions: number
	persons: number
}

export function getProductEventsFunnel({ data }: { data: GetProductEventsFunnelInput }) {
	return getProductEventsFunnelEffect({ data })
}

const getProductEventsFunnelEffect = Effect.fn("QueryEngine.getProductEventsFunnel")(function* ({
	data,
}: {
	data: GetProductEventsFunnelInput
}) {
	const input = yield* decodeInput(ProductEventsFunnelInputSchema, data, "getProductEventsFunnel")

	const result = yield* runWarehouseQuery("productEventsFunnel", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.productEventsFunnel({
				payload: new ProductEventsFunnelRequest(input),
			})
		}),
	)

	return { data: result.data satisfies ReadonlyArray<FunnelStepCount> }
})

export function getProductEventsFunnelBreakdown({ data }: { data: GetProductEventsFunnelBreakdownInput }) {
	return getProductEventsFunnelBreakdownEffect({ data })
}

const getProductEventsFunnelBreakdownEffect = Effect.fn("QueryEngine.getProductEventsFunnelBreakdown")(
	function* ({ data }: { data: GetProductEventsFunnelBreakdownInput }) {
		const input = yield* decodeInput(
			ProductEventsFunnelBreakdownInputSchema,
			data,
			"getProductEventsFunnelBreakdown",
		)

		const result = yield* runWarehouseQuery("productEventsFunnelBreakdown", () =>
			Effect.gen(function* () {
				const client = yield* MapleInternalAtomClient
				return yield* client.queryEngine.productEventsFunnelBreakdown({
					payload: new ProductEventsFunnelBreakdownRequest(input),
				})
			}),
		)

		return { data: result.data satisfies ReadonlyArray<FunnelBreakdownRow> }
	},
)

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

/** The default key and window a widget without them runs with — same as the /analytics view. */
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
