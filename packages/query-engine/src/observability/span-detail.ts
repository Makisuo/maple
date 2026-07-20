import { Array as Arr, Effect, Option, Schema, pipe } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const parseAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(([, v]) => v !== ""),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

const tinybirdDateTime = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 19)
const DEFAULT_RANGE_HOURS = 1

export interface SpanDetailInput {
	readonly traceId: string
	readonly spanId: string
	/**
	 * Approximate timestamp of the span. The point lookup is O(log N) on the
	 * `(OrgId, TraceId, SpanId)` sort key even without it, but passing it lets
	 * ClickHouse prune partitions to a window around the span.
	 */
	readonly timestampHint?: Date
	/** Half-width of the time window when `timestampHint` is set. Defaults to 1h. */
	readonly rangeHours?: number
}

export interface SpanDetailResult {
	readonly found: boolean
	readonly traceId: string
	readonly spanId: string
	/** Full span attribute map (not the trimmed set the trace tree renders). */
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
}

/**
 * Fetch the full attribute set for one span. Complements `inspectTrace`, whose
 * tree view intentionally projects only a trimmed set of attributes per span.
 */
export const spanDetail = Effect.fn("Observability.spanDetail")(function* (input: SpanDetailInput) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		traceId: input.traceId,
		spanId: input.spanId,
	})

	const narrowByTime = input.timestampHint != null
	const range = input.timestampHint
		? (() => {
				const halfWidthMs = (input.rangeHours ?? DEFAULT_RANGE_HOURS) * 60 * 60 * 1000
				return {
					startTime: tinybirdDateTime(new Date(input.timestampHint.getTime() - halfWidthMs)),
					endTime: tinybirdDateTime(new Date(input.timestampHint.getTime() + halfWidthMs)),
				}
			})()
		: undefined

	const compiled = CH.compile(
		CH.spanDetailQuery({ traceId: input.traceId, spanId: input.spanId, narrowByTime }),
		range
			? { orgId: executor.orgId, startTime: range.startTime, endTime: range.endTime }
			: { orgId: executor.orgId },
	)
	const maybeRow = yield* executor.compiledQueryFirst(compiled, {
		profile: "discovery",
		context: "spanDetail",
	})

	if (Option.isNone(maybeRow)) {
		return {
			found: false,
			traceId: input.traceId,
			spanId: input.spanId,
			spanAttributes: {},
			resourceAttributes: {},
		} satisfies SpanDetailResult
	}

	const row = maybeRow.value
	const spanAttributes = yield* parseAttributes(row.spanAttributes ?? "{}")
	const resourceAttributes = yield* parseAttributes(row.resourceAttributes ?? "{}")
	return {
		found: true,
		traceId: row.traceId,
		spanId: row.spanId,
		spanAttributes,
		resourceAttributes,
	} satisfies SpanDetailResult
})
