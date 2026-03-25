import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { QueryEngineExecuteRequest, QueryEngineExecuteResponse } from "../query-engine"
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
    causeTag: Schema.optionalKey(Schema.String),
    pipe: Schema.optionalKey(TinybirdPipeSchema),
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
  .prefix("/api/query-engine")
  .middleware(Authorization) {}
