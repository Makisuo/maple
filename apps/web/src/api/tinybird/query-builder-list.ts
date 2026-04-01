import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  buildListQuerySpec,
  type QueryBuilderMetricType,
} from "@/lib/query-builder/model"
import {
  decodeInput,
  TinybirdQueryError,
} from "@/api/tinybird/effect-utils"

const dateTimeString = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
)

const METRIC_TYPES_TUPLE = [
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
] as const

const QueryDraftSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  dataSource: Schema.Literals(["traces", "logs", "metrics"]),
  signalSource: Schema.Literals(["default", "meter"]),
  metricName: Schema.String,
  metricType: Schema.Literals(METRIC_TYPES_TUPLE),
  isMonotonic: Schema.optionalKey(Schema.Boolean),
  whereClause: Schema.String,
  aggregation: Schema.String,
  stepInterval: Schema.String,
  orderByDirection: Schema.Literals(["desc", "asc"]),
  addOns: Schema.Struct({
    groupBy: Schema.Boolean,
    having: Schema.Boolean,
    orderBy: Schema.Boolean,
    limit: Schema.Boolean,
    legend: Schema.Boolean,
  }),
  groupBy: Schema.mutable(Schema.Array(Schema.String)),
  having: Schema.String,
  orderBy: Schema.String,
  limit: Schema.String,
  legend: Schema.String,
})

const QueryBuilderListInputSchema = Schema.Struct({
  startTime: dateTimeString,
  endTime: dateTimeString,
  queries: Schema.mutable(Schema.Array(QueryDraftSchema)),
  limit: Schema.optional(Schema.Number),
})

export type QueryBuilderListInput = Schema.Schema.Type<typeof QueryBuilderListInputSchema>

export interface QueryBuilderListResponse {
  data: Array<Record<string, unknown>>
}

const decodeQueryEngineRequest = Schema.decodeUnknownSync(QueryEngineExecuteRequest)

const executeListQueryEffect = Effect.fn("Tinybird.executeListQuery")(
  function* (payload: QueryEngineExecuteRequest) {
    const client = yield* MapleApiAtomClient
    return yield* client.queryEngine.execute({
      payload: new QueryEngineExecuteRequest(payload),
    })
  },
)

async function executeListQueryInternal(
  input: QueryBuilderListInput,
): Promise<QueryBuilderListResponse> {
  const enabledQueries = input.queries.filter((q) => q.enabled)
  if (enabledQueries.length === 0) {
    throw new Error("No enabled queries to run")
  }

  // Use the first enabled query for the list
  const query = enabledQueries[0]
  const built = buildListQuerySpec(
    { ...query, metricType: query.metricType as QueryBuilderMetricType, isMonotonic: query.isMonotonic ?? (query.metricType === "sum") },
    input.limit,
  )

  if (!built.query) {
    throw new Error(built.error ?? "Failed to build list query")
  }

  const payload = decodeQueryEngineRequest({
    startTime: input.startTime,
    endTime: input.endTime,
    query: built.query,
  })

  const response = await Effect.runPromise(
    executeListQueryEffect(payload).pipe(Effect.provide(MapleApiAtomClient.layer)),
  )

  if (response.result.kind !== "list") {
    throw new Error(`Unexpected result kind: ${response.result.kind}`)
  }

  return {
    data: response.result.data as Array<Record<string, unknown>>,
  }
}

export function getQueryBuilderList({
  data,
}: {
  data: QueryBuilderListInput
}) {
  return getQueryBuilderListEffect({ data })
}

const getQueryBuilderListEffect = Effect.fn("Tinybird.getQueryBuilderList")(
  function* ({
    data,
  }: {
    data: QueryBuilderListInput
  }) {
    const input = yield* decodeInput(
      QueryBuilderListInputSchema,
      data,
      "getQueryBuilderList",
    )

    return yield* Effect.tryPromise({
      try: () => executeListQueryInternal(input),
      catch: (cause) =>
        new TinybirdQueryError({
          operation: "getQueryBuilderList",
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to fetch query-builder list",
          cause,
        }),
    })
  },
)
