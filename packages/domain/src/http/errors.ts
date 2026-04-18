import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
  ErrorIncidentId,
  ErrorIssueId,
  IsoDateTimeString,
} from "../primitives"
import { Authorization } from "./current-tenant"

export const ErrorIssueStatus = Schema.Literals([
  "open",
  "resolved",
  "ignored",
  "archived",
]).annotate({
  identifier: "@maple/ErrorIssueStatus",
  title: "Error Issue Status",
})
export type ErrorIssueStatus = Schema.Schema.Type<typeof ErrorIssueStatus>

export const ErrorIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
  identifier: "@maple/ErrorIncidentStatus",
  title: "Error Incident Status",
})
export type ErrorIncidentStatus = Schema.Schema.Type<typeof ErrorIncidentStatus>

export const ErrorIncidentReason = Schema.Literals([
  "first_seen",
  "regression",
  "manual",
]).annotate({
  identifier: "@maple/ErrorIncidentReason",
  title: "Error Incident Reason",
})
export type ErrorIncidentReason = Schema.Schema.Type<typeof ErrorIncidentReason>

export class ErrorIssueDocument extends Schema.Class<ErrorIssueDocument>(
  "ErrorIssueDocument",
)({
  id: ErrorIssueId,
  fingerprintHash: Schema.String,
  serviceName: Schema.String,
  exceptionType: Schema.String,
  exceptionMessage: Schema.String,
  topFrame: Schema.String,
  status: ErrorIssueStatus,
  assignedTo: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  firstSeenAt: IsoDateTimeString,
  lastSeenAt: IsoDateTimeString,
  occurrenceCount: Schema.Number,
  resolvedAt: Schema.NullOr(IsoDateTimeString),
  resolvedBy: Schema.NullOr(Schema.String),
  ignoredUntil: Schema.NullOr(IsoDateTimeString),
  hasOpenIncident: Schema.Boolean,
}) {}

export class ErrorIssuesListResponse extends Schema.Class<ErrorIssuesListResponse>(
  "ErrorIssuesListResponse",
)({
  issues: Schema.Array(ErrorIssueDocument),
}) {}

export class ErrorIssueTimeseriesPoint extends Schema.Class<ErrorIssueTimeseriesPoint>(
  "ErrorIssueTimeseriesPoint",
)({
  bucket: IsoDateTimeString,
  count: Schema.Number,
}) {}

export class ErrorIssueSampleTrace extends Schema.Class<ErrorIssueSampleTrace>(
  "ErrorIssueSampleTrace",
)({
  traceId: Schema.String,
  spanId: Schema.String,
  serviceName: Schema.String,
  timestamp: IsoDateTimeString,
  exceptionMessage: Schema.String,
  durationMicros: Schema.Number,
}) {}

export class ErrorIncidentDocument extends Schema.Class<ErrorIncidentDocument>(
  "ErrorIncidentDocument",
)({
  id: ErrorIncidentId,
  issueId: ErrorIssueId,
  status: ErrorIncidentStatus,
  reason: ErrorIncidentReason,
  firstTriggeredAt: IsoDateTimeString,
  lastTriggeredAt: IsoDateTimeString,
  resolvedAt: Schema.NullOr(IsoDateTimeString),
  occurrenceCount: Schema.Number,
}) {}

export class ErrorIssueDetailResponse extends Schema.Class<ErrorIssueDetailResponse>(
  "ErrorIssueDetailResponse",
)({
  issue: ErrorIssueDocument,
  timeseries: Schema.Array(ErrorIssueTimeseriesPoint),
  sampleTraces: Schema.Array(ErrorIssueSampleTrace),
  incidents: Schema.Array(ErrorIncidentDocument),
}) {}

export class ErrorIncidentsListResponse extends Schema.Class<ErrorIncidentsListResponse>(
  "ErrorIncidentsListResponse",
)({
  incidents: Schema.Array(ErrorIncidentDocument),
}) {}

export class ErrorIssueUpdateRequest extends Schema.Class<ErrorIssueUpdateRequest>(
  "ErrorIssueUpdateRequest",
)({
  status: Schema.optionalKey(ErrorIssueStatus),
  assignedTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ignoredUntil: Schema.optionalKey(Schema.NullOr(IsoDateTimeString)),
}) {}

const IssueListQuery = Schema.Struct({
  status: Schema.optional(ErrorIssueStatus),
  service: Schema.optional(Schema.String),
  deploymentEnv: Schema.optional(Schema.String),
  startTime: Schema.optional(IsoDateTimeString),
  endTime: Schema.optional(IsoDateTimeString),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 500 }),
    ),
  ),
})

const IssueDetailQuery = Schema.Struct({
  startTime: Schema.optional(IsoDateTimeString),
  endTime: Schema.optional(IsoDateTimeString),
  bucketSeconds: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 60, maximum: 86_400 }),
    ),
  ),
  sampleLimit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 100 }),
    ),
  ),
})

export class ErrorPersistenceError extends Schema.TaggedErrorClass<ErrorPersistenceError>()(
  "@maple/http/errors/ErrorPersistenceError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class ErrorValidationError extends Schema.TaggedErrorClass<ErrorValidationError>()(
  "@maple/http/errors/ErrorValidationError",
  {
    message: Schema.String,
    details: Schema.Array(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class ErrorIssueNotFoundError extends Schema.TaggedErrorClass<ErrorIssueNotFoundError>()(
  "@maple/http/errors/ErrorIssueNotFoundError",
  {
    message: Schema.String,
    resourceType: Schema.String,
    resourceId: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ErrorsApiGroup extends HttpApiGroup.make("errors")
  .add(
    HttpApiEndpoint.get("listIssues", "/issues", {
      query: IssueListQuery,
      success: ErrorIssuesListResponse,
      error: ErrorPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIssue", "/issues/:issueId", {
      params: { issueId: ErrorIssueId },
      query: IssueDetailQuery,
      success: ErrorIssueDetailResponse,
      error: [ErrorPersistenceError, ErrorIssueNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateIssue", "/issues/:issueId", {
      params: { issueId: ErrorIssueId },
      payload: ErrorIssueUpdateRequest,
      success: ErrorIssueDocument,
      error: [ErrorPersistenceError, ErrorIssueNotFoundError, ErrorValidationError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listIssueIncidents", "/issues/:issueId/incidents", {
      params: { issueId: ErrorIssueId },
      success: ErrorIncidentsListResponse,
      error: [ErrorPersistenceError, ErrorIssueNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listOpenIncidents", "/incidents", {
      success: ErrorIncidentsListResponse,
      error: ErrorPersistenceError,
    }),
  )
  .prefix("/api/errors")
  .middleware(Authorization) {}
