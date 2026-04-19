import { Schema } from "effect"

const MapleId = (identifier: string, title: string) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isTrimmed(),
  ).pipe(
    Schema.brand(identifier),
    Schema.annotate({ identifier, title }),
  )

const MapleUuidId = (identifier: string, title: string) =>
  Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand(identifier),
    Schema.annotate({ identifier, title }),
  )

export const TraceId = MapleId("@maple/TraceId", "Trace ID")
export type TraceId = Schema.Schema.Type<typeof TraceId>

export const SpanId = MapleId("@maple/SpanId", "Span ID")
export type SpanId = Schema.Schema.Type<typeof SpanId>

export const OrgId = MapleId("@maple/OrgId", "Org ID")
export type OrgId = Schema.Schema.Type<typeof OrgId>

export const UserId = MapleId("@maple/UserId", "User ID")
export type UserId = Schema.Schema.Type<typeof UserId>

export const RoleName = MapleId("@maple/RoleName", "Role Name")
export type RoleName = Schema.Schema.Type<typeof RoleName>

export const DashboardId = MapleId("@maple/DashboardId", "Dashboard ID")
export type DashboardId = Schema.Schema.Type<typeof DashboardId>

export const IngestKeyId = MapleId("@maple/IngestKeyId", "Ingest Key ID")
export type IngestKeyId = Schema.Schema.Type<typeof IngestKeyId>

export const ApiKeyId = MapleUuidId("@maple/ApiKeyId", "API Key ID")
export type ApiKeyId = Schema.Schema.Type<typeof ApiKeyId>

export const ScrapeTargetId = MapleUuidId(
  "@maple/ScrapeTargetId",
  "Scrape Target ID",
)
export type ScrapeTargetId = Schema.Schema.Type<typeof ScrapeTargetId>

export const CloudflareLogpushConnectorId = MapleUuidId(
  "@maple/CloudflareLogpushConnectorId",
  "Cloudflare Logpush Connector ID",
)
export type CloudflareLogpushConnectorId = Schema.Schema.Type<
  typeof CloudflareLogpushConnectorId
>

export const AlertDestinationId = MapleUuidId(
  "@maple/AlertDestinationId",
  "Alert Destination ID",
)
export type AlertDestinationId = Schema.Schema.Type<typeof AlertDestinationId>

export const AlertRuleId = MapleUuidId("@maple/AlertRuleId", "Alert Rule ID")
export type AlertRuleId = Schema.Schema.Type<typeof AlertRuleId>

export const AlertIncidentId = MapleUuidId(
  "@maple/AlertIncidentId",
  "Alert Incident ID",
)
export type AlertIncidentId = Schema.Schema.Type<typeof AlertIncidentId>

export const AlertDeliveryEventId = MapleUuidId(
  "@maple/AlertDeliveryEventId",
  "Alert Delivery Event ID",
)
export type AlertDeliveryEventId = Schema.Schema.Type<
  typeof AlertDeliveryEventId
>

export const ErrorIssueId = MapleUuidId("@maple/ErrorIssueId", "Error Issue ID")
export type ErrorIssueId = Schema.Schema.Type<typeof ErrorIssueId>

export const ErrorIncidentId = MapleUuidId(
  "@maple/ErrorIncidentId",
  "Error Incident ID",
)
export type ErrorIncidentId = Schema.Schema.Type<typeof ErrorIncidentId>

export const ActorId = MapleUuidId("@maple/ActorId", "Actor ID")
export type ActorId = Schema.Schema.Type<typeof ActorId>

export const ErrorIssueEventId = MapleUuidId(
  "@maple/ErrorIssueEventId",
  "Error Issue Event ID",
)
export type ErrorIssueEventId = Schema.Schema.Type<typeof ErrorIssueEventId>

export const AuthMode = Schema.Literals(["clerk", "self_hosted"]).annotate({
  identifier: "@maple/AuthMode",
  title: "Auth Mode",
})
export type AuthMode = Schema.Schema.Type<typeof AuthMode>

export const IsoDateTimeString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
      description: "Expected an ISO date-time string",
    }),
  ),
  Schema.brand("@maple/IsoDateTimeString"),
  Schema.annotate({
    identifier: "@maple/IsoDateTimeString",
    title: "ISO Date-Time String",
  }),
)
export type IsoDateTimeString = Schema.Schema.Type<typeof IsoDateTimeString>

export const ScrapeIntervalSeconds = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(5),
    Schema.isLessThanOrEqualTo(300),
  ),
  Schema.brand("@maple/ScrapeIntervalSeconds"),
  Schema.annotate({
    identifier: "@maple/ScrapeIntervalSeconds",
    title: "Scrape Interval Seconds",
  }),
)
export type ScrapeIntervalSeconds = Schema.Schema.Type<
  typeof ScrapeIntervalSeconds
>

export const ScrapeAuthType = Schema.Literals(["none", "bearer", "basic"]).annotate(
  {
    identifier: "@maple/ScrapeAuthType",
    title: "Scrape Auth Type",
  },
)
export type ScrapeAuthType = Schema.Schema.Type<typeof ScrapeAuthType>

export const TinybirdDeploymentId = MapleId(
  "@maple/TinybirdDeploymentId",
  "Tinybird Deployment ID",
)
export type TinybirdDeploymentId = Schema.Schema.Type<typeof TinybirdDeploymentId>

export const TinybirdProjectRevision = MapleId(
  "@maple/TinybirdProjectRevision",
  "Tinybird Project Revision",
)
export type TinybirdProjectRevision = Schema.Schema.Type<
  typeof TinybirdProjectRevision
>

export const TinybirdHost = MapleId("@maple/TinybirdHost", "Tinybird Host")
export type TinybirdHost = Schema.Schema.Type<typeof TinybirdHost>
