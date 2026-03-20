import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
  QueryBuilderExecuteRequest,
  QueryBuilderExecuteResponse,
  QueryBuilderFieldValuesRequest,
  QueryBuilderFieldValuesResponse,
  QueryBuilderMetadataRequest,
  QueryBuilderMetadataResponse,
  QueryBuilderPlanRequest,
  QueryBuilderPlanResponse,
  QueryEngineExecuteRequest,
  QueryEngineExecuteResponse,
} from "../query-engine"
import { tinybirdPipes } from "../tinybird-pipes"
import { Authorization } from "./current-tenant"

const TinybirdPipeSchema = Schema.Literals(tinybirdPipes)

export class QueryEngineValidationError extends Schema.TaggedErrorClass<QueryEngineValidationError>()(
  "QueryEngineValidationError",
  {
    message: Schema.String,
    details: Schema.Array(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class QueryEngineExecutionError extends Schema.TaggedErrorClass<QueryEngineExecutionError>()(
  "QueryEngineExecutionError",
  {
    message: Schema.String,
    causeTag: Schema.optional(Schema.String),
    pipe: Schema.optional(TinybirdPipeSchema),
  },
  { httpApiStatus: 502 },
) {}

export class QueryEngineApiGroup extends HttpApiGroup.make("queryEngine")
  .add(
    HttpApiEndpoint.post("execute", "/execute", {
      payload: QueryEngineExecuteRequest,
      success: QueryEngineExecuteResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("builderMetadata", "/builder/metadata", {
      payload: QueryBuilderMetadataRequest,
      success: QueryBuilderMetadataResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("builderFieldValues", "/builder/field-values", {
      payload: QueryBuilderFieldValuesRequest,
      success: QueryBuilderFieldValuesResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("builderPlan", "/builder/plan", {
      payload: QueryBuilderPlanRequest,
      success: QueryBuilderPlanResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("builderExecute", "/builder/execute", {
      payload: QueryBuilderExecuteRequest,
      success: QueryBuilderExecuteResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError],
    }),
  )
  .prefix("/api/query-engine")
  .middleware(Authorization) {}
