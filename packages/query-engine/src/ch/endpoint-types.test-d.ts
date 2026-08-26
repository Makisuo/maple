// Type-level tests: the wire contract matches the queries that fill it
//
// `@maple/domain`'s `*Output` interfaces are hand-written and type-only, and
// `@maple/query-engine` compiles the SQL that produces those rows — two
// declarations of one shape, kept in step by hand. They had already drifted:
// `list_logs` has selected a `recordIdentity` cursor column for as long as
// keyset pagination has existed, and `ListLogsOutput` never mentioned it.
//
// Domain cannot import the query engine (the dependency runs the other way), so
// the wire types cannot simply be derived from the queries. This is the next
// best thing and it fails in the same place a derivation would: adding,
// removing, or retyping a selected column without touching the interface is a
// typecheck error here.

import { expectTypeOf } from "expect-type"
import type {
	ErrorDetailTracesOutput,
	ErrorsFacetsOutput,
	ErrorsTimeseriesOutput,
	GetServiceUsageOutput,
	ListMetricsOutput,
	LogsFacetsOutput,
	MetricsSummaryOutput,
	ResourceAttributeValuesOutput,
	ServiceApdexTimeSeriesOutput,
	ServiceReleasesTimelineOutput,
	ServicesFacetsOutput,
	ErrorRateByServiceOutput,
	ErrorsSummaryOutput,
	ListLogsOutput,
	ListTracesOutput,
	LogsCountOutput,
	SpanAttributeValuesOutput,
	SpanHierarchyOutput,
	TracesDurationStatsOutput,
} from "@maple/domain/tinybird"
import type { InferQueryOutput } from "@maple-dev/clickhouse-builder"
import { resourceAttributeValuesQuery, spanAttributeValuesQuery } from "./queries/attribute-keys"
import {
	errorDetailTracesQuery,
	errorsFacetsQuery,
	errorsSummaryQuery,
	errorsTimeseriesQuery,
	spanHierarchyQuery,
	tracesDurationStatsQuery,
} from "./queries/errors"
import { errorRateByServiceQuery, logsCountQuery, logsFacetsQuery, logsListQuery } from "./queries/logs"
import { tracesRootListQuery } from "./queries/traces"
import { listMetricsQuery, metricsSummaryQuery } from "./queries/metrics"
import {
	serviceApdexTimeseriesQuery,
	serviceReleasesTimelineQuery,
	servicesFacetsQuery,
	serviceUsageQuery,
} from "./queries/services"

/** The output a query builder produces, for a function returning one. */
type OutputOf<F extends (...args: never) => unknown> = InferQueryOutput<ReturnType<F>>

/**
 * `true` only when two objects have exactly the same keys.
 *
 * Assignability alone would not do: structural typing lets a row with an extra
 * column satisfy an interface that omits it, which is precisely the drift that
 * went unnoticed.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
	? [keyof B] extends [keyof A]
		? true
		: { missingFromFirst: Exclude<keyof B, keyof A> }
	: { missingFromSecond: Exclude<keyof A, keyof B> }

/**
 * The keys whose value types disagree, as `{ key: [fromQuery, fromInterface] }`.
 *
 * Keys alone would miss the drift that actually breaks a client: a column that
 * changed from a String to a UInt64, or an array that stopped being an array.
 */
type ValueMismatches<A, B> = {
	[K in keyof A & keyof B as A[K] extends B[K] ? never : K]: [A[K], B[K]]
}

expectTypeOf<SameKeys<OutputOf<typeof tracesRootListQuery>, ListTracesOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof spanHierarchyQuery>, SpanHierarchyOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof logsListQuery>, ListLogsOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof logsCountQuery>, LogsCountOutput>>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof errorRateByServiceQuery>, ErrorRateByServiceOutput>
>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof tracesDurationStatsQuery>, TracesDurationStatsOutput>
>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof errorsSummaryQuery>, ErrorsSummaryOutput>>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof errorDetailTracesQuery>, ErrorDetailTracesOutput>
>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof spanAttributeValuesQuery>, SpanAttributeValuesOutput>
>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof logsFacetsQuery>, LogsFacetsOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof errorsFacetsQuery>, ErrorsFacetsOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof errorsTimeseriesQuery>, ErrorsTimeseriesOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof listMetricsQuery>, ListMetricsOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof metricsSummaryQuery>, MetricsSummaryOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof servicesFacetsQuery>, ServicesFacetsOutput>>().toEqualTypeOf<true>()
expectTypeOf<SameKeys<OutputOf<typeof serviceUsageQuery>, GetServiceUsageOutput>>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof serviceApdexTimeseriesQuery>, ServiceApdexTimeSeriesOutput>
>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof serviceReleasesTimelineQuery>, ServiceReleasesTimelineOutput>
>().toEqualTypeOf<true>()
expectTypeOf<
	SameKeys<OutputOf<typeof resourceAttributeValuesQuery>, ResourceAttributeValuesOutput>
>().toEqualTypeOf<true>()

// Value types, per key.
expectTypeOf<ValueMismatches<OutputOf<typeof tracesRootListQuery>, ListTracesOutput>>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof spanHierarchyQuery>, SpanHierarchyOutput>>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof logsListQuery>, ListLogsOutput>>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof logsCountQuery>, LogsCountOutput>>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof errorRateByServiceQuery>, ErrorRateByServiceOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof tracesDurationStatsQuery>, TracesDurationStatsOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof errorsSummaryQuery>, ErrorsSummaryOutput>>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof errorDetailTracesQuery>, ErrorDetailTracesOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof spanAttributeValuesQuery>, SpanAttributeValuesOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof logsFacetsQuery>, LogsFacetsOutput>>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof errorsFacetsQuery>, ErrorsFacetsOutput>>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof errorsTimeseriesQuery>, ErrorsTimeseriesOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof listMetricsQuery>, ListMetricsOutput>>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof metricsSummaryQuery>, MetricsSummaryOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof servicesFacetsQuery>, ServicesFacetsOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<ValueMismatches<OutputOf<typeof serviceUsageQuery>, GetServiceUsageOutput>>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof serviceApdexTimeseriesQuery>, ServiceApdexTimeSeriesOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof serviceReleasesTimelineQuery>, ServiceReleasesTimelineOutput>
>().toEqualTypeOf<{}>()
expectTypeOf<
	ValueMismatches<OutputOf<typeof resourceAttributeValuesQuery>, ResourceAttributeValuesOutput>
>().toEqualTypeOf<{}>()
