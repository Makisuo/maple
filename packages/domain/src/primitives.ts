import { Schema } from "effect"

const MapleId = <const Id extends string>(identifier: Id, title: string) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()).pipe(
		Schema.brand(identifier),
		Schema.annotate({ identifier, title }),
	)

const MapleUuidId = <const Id extends string>(identifier: Id, title: string) =>
	Schema.String.check(Schema.isUUID()).pipe(
		Schema.brand(identifier),
		Schema.annotate({ identifier, title }),
	)

// Telemetry dimension primitives are intentionally permissive (no minLength/trim):
// real OpenTelemetry data legitimately carries empty service namespaces, deployment
// environments, etc., so a strict check would make response decoding throw on live data.
const MapleTelemetry = <const Id extends string>(identifier: Id, title: string) =>
	Schema.String.pipe(Schema.brand(identifier), Schema.annotate({ identifier, title }))

export const TraceId = MapleId("@maple/TraceId", "Trace ID")
export type TraceId = Schema.Schema.Type<typeof TraceId>

export const SpanId = MapleId("@maple/SpanId", "Span ID")
export type SpanId = Schema.Schema.Type<typeof SpanId>

export const SessionId = MapleId("@maple/SessionId", "Session ID")
export type SessionId = Schema.Schema.Type<typeof SessionId>

export const OrgId = MapleId("@maple/OrgId", "Org ID")
export type OrgId = Schema.Schema.Type<typeof OrgId>

export const UserId = MapleId("@maple/UserId", "User ID")
export type UserId = Schema.Schema.Type<typeof UserId>

export const RoleName = MapleId("@maple/RoleName", "Role Name")
export type RoleName = Schema.Schema.Type<typeof RoleName>

export const DashboardId = MapleId("@maple/DashboardId", "Dashboard ID")
export type DashboardId = Schema.Schema.Type<typeof DashboardId>

export const DashboardVersionId = MapleUuidId("@maple/DashboardVersionId", "Dashboard Version ID")
export type DashboardVersionId = Schema.Schema.Type<typeof DashboardVersionId>

export const DashboardTemplateId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(
	Schema.brand("@maple/DashboardTemplateId"),
	Schema.annotate({ identifier: "@maple/DashboardTemplateId", title: "Dashboard Template ID" }),
)
export type DashboardTemplateId = Schema.Schema.Type<typeof DashboardTemplateId>

export const DashboardTemplateParameterKey = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isPattern(/^[a-z][a-z0-9_]*$/),
).pipe(
	Schema.brand("@maple/DashboardTemplateParameterKey"),
	Schema.annotate({
		identifier: "@maple/DashboardTemplateParameterKey",
		title: "Dashboard Template Parameter Key",
	}),
)
export type DashboardTemplateParameterKey = Schema.Schema.Type<typeof DashboardTemplateParameterKey>

export const DashboardTemplateCategory = Schema.Literals([
	"application",
	"database",
	"infrastructure",
	"messaging",
]).annotate({
	identifier: "@maple/DashboardTemplateCategory",
	title: "Dashboard Template Category",
})
export type DashboardTemplateCategory = Schema.Schema.Type<typeof DashboardTemplateCategory>

export const IngestKeyId = MapleId("@maple/IngestKeyId", "Ingest Key ID")
export type IngestKeyId = Schema.Schema.Type<typeof IngestKeyId>

export const ApiKeyId = MapleUuidId("@maple/ApiKeyId", "API Key ID")
export type ApiKeyId = Schema.Schema.Type<typeof ApiKeyId>

export const ScrapeTargetId = MapleUuidId("@maple/ScrapeTargetId", "Scrape Target ID")
export type ScrapeTargetId = Schema.Schema.Type<typeof ScrapeTargetId>

export const AlertDestinationId = MapleUuidId("@maple/AlertDestinationId", "Alert Destination ID")
export type AlertDestinationId = Schema.Schema.Type<typeof AlertDestinationId>

export const AlertRuleId = MapleUuidId("@maple/AlertRuleId", "Alert Rule ID")
export type AlertRuleId = Schema.Schema.Type<typeof AlertRuleId>

export const AlertIncidentId = MapleUuidId("@maple/AlertIncidentId", "Alert Incident ID")
export type AlertIncidentId = Schema.Schema.Type<typeof AlertIncidentId>

export const AlertDeliveryEventId = MapleUuidId("@maple/AlertDeliveryEventId", "Alert Delivery Event ID")
export type AlertDeliveryEventId = Schema.Schema.Type<typeof AlertDeliveryEventId>

export const ErrorIssueId = MapleUuidId("@maple/ErrorIssueId", "Error Issue ID")
export type ErrorIssueId = Schema.Schema.Type<typeof ErrorIssueId>

export const ErrorIncidentId = MapleUuidId("@maple/ErrorIncidentId", "Error Incident ID")
export type ErrorIncidentId = Schema.Schema.Type<typeof ErrorIncidentId>

export const ActorId = MapleUuidId("@maple/ActorId", "Actor ID")
export type ActorId = Schema.Schema.Type<typeof ActorId>

export const ErrorIssueEventId = MapleUuidId("@maple/ErrorIssueEventId", "Error Issue Event ID")
export type ErrorIssueEventId = Schema.Schema.Type<typeof ErrorIssueEventId>

export const AnomalyIncidentId = MapleUuidId("@maple/AnomalyIncidentId", "Anomaly Incident ID")
export type AnomalyIncidentId = Schema.Schema.Type<typeof AnomalyIncidentId>

export const AiTriageRunId = MapleUuidId("@maple/AiTriageRunId", "AI Triage Run ID")
export type AiTriageRunId = Schema.Schema.Type<typeof AiTriageRunId>

export const InvestigationId = MapleUuidId("@maple/InvestigationId", "Investigation ID")
export type InvestigationId = Schema.Schema.Type<typeof InvestigationId>

export const AuthMode = Schema.Literals(["clerk", "self_hosted"]).annotate({
	identifier: "@maple/AuthMode",
	title: "Auth Mode",
})
export type AuthMode = Schema.Schema.Type<typeof AuthMode>

export const IsoDateTimeString = Schema.String.check(
	Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
		description: "Expected an ISO date-time string",
	}),
).pipe(
	Schema.brand("@maple/IsoDateTimeString"),
	Schema.annotate({
		identifier: "@maple/IsoDateTimeString",
		title: "ISO Date-Time String",
	}),
)
export type IsoDateTimeString = Schema.Schema.Type<typeof IsoDateTimeString>

export const ScrapeIntervalSeconds = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(5),
	Schema.isLessThanOrEqualTo(300),
).pipe(
	Schema.brand("@maple/ScrapeIntervalSeconds"),
	Schema.annotate({
		identifier: "@maple/ScrapeIntervalSeconds",
		title: "Scrape Interval Seconds",
	}),
)
export type ScrapeIntervalSeconds = Schema.Schema.Type<typeof ScrapeIntervalSeconds>

export const ScrapeAuthType = Schema.Literals(["none", "bearer", "basic", "token"]).annotate({
	identifier: "@maple/ScrapeAuthType",
	title: "Scrape Auth Type",
})
export type ScrapeAuthType = Schema.Schema.Type<typeof ScrapeAuthType>

export const ScrapeTargetType = Schema.Literals(["prometheus", "planetscale"]).annotate({
	identifier: "@maple/ScrapeTargetType",
	title: "Scrape Target Type",
})
export type ScrapeTargetType = Schema.Schema.Type<typeof ScrapeTargetType>

export const IngestAttributeMappingId = MapleUuidId(
	"@maple/IngestAttributeMappingId",
	"Ingest Attribute Mapping ID",
)
export type IngestAttributeMappingId = Schema.Schema.Type<typeof IngestAttributeMappingId>

export const IngestMappingSourceContext = Schema.Literals(["span", "resource"]).annotate({
	identifier: "@maple/IngestMappingSourceContext",
	title: "Ingest Mapping Source Context",
})
export type IngestMappingSourceContext = Schema.Schema.Type<typeof IngestMappingSourceContext>

export const IngestMappingOperation = Schema.Literals(["move", "copy"]).annotate({
	identifier: "@maple/IngestMappingOperation",
	title: "Ingest Mapping Operation",
})
export type IngestMappingOperation = Schema.Schema.Type<typeof IngestMappingOperation>

export const RecommendationIssueId = MapleUuidId("@maple/RecommendationIssueId", "Recommendation Issue ID")
export type RecommendationIssueId = Schema.Schema.Type<typeof RecommendationIssueId>

export const TinybirdDeploymentId = MapleId("@maple/TinybirdDeploymentId", "Tinybird Deployment ID")
export type TinybirdDeploymentId = Schema.Schema.Type<typeof TinybirdDeploymentId>

export const TinybirdProjectRevision = MapleId("@maple/TinybirdProjectRevision", "Tinybird Project Revision")
export type TinybirdProjectRevision = Schema.Schema.Type<typeof TinybirdProjectRevision>

export const TinybirdHost = MapleId("@maple/TinybirdHost", "Tinybird Host")
export type TinybirdHost = Schema.Schema.Type<typeof TinybirdHost>

// ---------------------------------------------------------------------------
// Telemetry dimension primitives
// ---------------------------------------------------------------------------

export const ServiceName = MapleTelemetry("@maple/ServiceName", "Service Name")
export type ServiceName = Schema.Schema.Type<typeof ServiceName>

export const DeploymentEnvironment = MapleTelemetry("@maple/DeploymentEnvironment", "Deployment Environment")
export type DeploymentEnvironment = Schema.Schema.Type<typeof DeploymentEnvironment>

export const ServiceNamespace = MapleTelemetry("@maple/ServiceNamespace", "Service Namespace")
export type ServiceNamespace = Schema.Schema.Type<typeof ServiceNamespace>

export const SpanName = MapleTelemetry("@maple/SpanName", "Span Name")
export type SpanName = Schema.Schema.Type<typeof SpanName>

export const CommitSha = MapleTelemetry("@maple/CommitSha", "Commit SHA")
export type CommitSha = Schema.Schema.Type<typeof CommitSha>

export const FingerprintHash = MapleTelemetry("@maple/FingerprintHash", "Fingerprint Hash")
export type FingerprintHash = Schema.Schema.Type<typeof FingerprintHash>

export const MetricName = MapleTelemetry("@maple/MetricName", "Metric Name")
export type MetricName = Schema.Schema.Type<typeof MetricName>

// ---------------------------------------------------------------------------
// OpenTelemetry enums (closed value sets → modeled as literal unions)
// ---------------------------------------------------------------------------

// Title Case per the repo's span status convention; verified distinct values in the
// warehouse are exactly Ok / Error / Unset.
export const StatusCode = Schema.Literals(["Ok", "Error", "Unset"]).annotate({
	identifier: "@maple/StatusCode",
	title: "Span Status Code",
})
export type StatusCode = Schema.Schema.Type<typeof StatusCode>

export const SpanKind = Schema.Literals(["Internal", "Server", "Client", "Producer", "Consumer"]).annotate({
	identifier: "@maple/SpanKind",
	title: "Span Kind",
})
export type SpanKind = Schema.Schema.Type<typeof SpanKind>

export const HttpMethod = Schema.Literals([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
	"TRACE",
	"CONNECT",
]).annotate({
	identifier: "@maple/HttpMethod",
	title: "HTTP Method",
})
export type HttpMethod = Schema.Schema.Type<typeof HttpMethod>

// ---------------------------------------------------------------------------
// External / audit / dashboard reference IDs
// ---------------------------------------------------------------------------

export const ExternalUserId = MapleId("@maple/ExternalUserId", "External User ID")
export type ExternalUserId = Schema.Schema.Type<typeof ExternalUserId>

export const HazelOrganizationId = MapleId("@maple/HazelOrganizationId", "Hazel Organization ID")
export type HazelOrganizationId = Schema.Schema.Type<typeof HazelOrganizationId>

export const HazelChannelId = MapleId("@maple/HazelChannelId", "Hazel Channel ID")
export type HazelChannelId = Schema.Schema.Type<typeof HazelChannelId>

export const WidgetId = MapleId("@maple/WidgetId", "Widget ID")
export type WidgetId = Schema.Schema.Type<typeof WidgetId>

export const ChartId = MapleId("@maple/ChartId", "Chart ID")
export type ChartId = Schema.Schema.Type<typeof ChartId>
