/**
 * One entry point keyed on the result shape a widget stores.
 *
 * Its input is structurally `WidgetQuerySet` (`@maple/widgets`'s
 * `dataSourceQuerySet` return type): a `QuerySet` plus `resultShape` and the
 * per-shape request-shaping fields. That is structural compatibility on purpose
 * — `@maple/query-engine` must NOT import `@maple/widgets`, which sits below
 * `@maple/domain` and would invert the dependency. Do not "tidy" this into an
 * import.
 */

import { Effect } from "effect"
import type { QueryResultShape, QuerySet } from "@maple/query-model"
import type { EmptyRangeFallbackStrategy } from "./bucketing"
import { type BreakdownQuerySetResult, runBreakdownQuerySet } from "./breakdown"
import { type ListQuerySetResult, runListQuerySet } from "./list"
import type { QuerySetExecutor } from "./port"
import { type TimeseriesQuerySetResult, runTimeseriesQuerySet } from "./timeseries"

export type QuerySetRunOutput =
	| ({ readonly shape: "timeseries" } & TimeseriesQuerySetResult)
	| ({ readonly shape: "breakdown" } & BreakdownQuerySetResult)
	| ({ readonly shape: "list" } & ListQuerySetResult)

export interface RunQuerySetInput {
	readonly querySet: QuerySet
	readonly resultShape: QueryResultShape
	readonly startTime: string
	readonly endTime: string
	/** Per-shape request shaping; each field is read by exactly one shape. */
	readonly defaultLimit?: number
	readonly limit?: number
	readonly columns?: ReadonlyArray<string>
	/** Timeseries only. Defaults to no widening. */
	readonly fallback?: EmptyRangeFallbackStrategy
}

export const runQuerySet = Effect.fnUntraced(function* <E>(
	executor: QuerySetExecutor<E>,
	input: RunQuerySetInput,
) {
	switch (input.resultShape) {
		case "timeseries": {
			const result = yield* runTimeseriesQuerySet(executor, {
				querySet: input.querySet,
				startTime: input.startTime,
				endTime: input.endTime,
				...(input.fallback === undefined ? {} : { fallback: input.fallback }),
			})
			return { shape: "timeseries", ...result } satisfies QuerySetRunOutput
		}
		case "breakdown": {
			const result = yield* runBreakdownQuerySet(executor, {
				querySet: input.querySet,
				startTime: input.startTime,
				endTime: input.endTime,
				...(input.defaultLimit === undefined ? {} : { defaultLimit: input.defaultLimit }),
			})
			return { shape: "breakdown", ...result } satisfies QuerySetRunOutput
		}
		case "list": {
			const result = yield* runListQuerySet(executor, {
				querySet: input.querySet,
				startTime: input.startTime,
				endTime: input.endTime,
				...(input.limit === undefined ? {} : { limit: input.limit }),
				...(input.columns === undefined ? {} : { columns: input.columns }),
			})
			return { shape: "list", ...result } satisfies QuerySetRunOutput
		}
	}
})
