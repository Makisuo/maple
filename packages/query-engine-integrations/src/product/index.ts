// Product-surface queries that read telemetry but back one specific feature
// rather than a general signal: the instrumentation audit, billing spend, and
// Maple's own self-instrumentation.

export {
	auditAttributeKeyInventoryQuery,
	auditAttributeKeyInventoryRowSchema,
	auditSpanProfileByServiceQuery,
	auditSpanProfileRowSchema,
	auditSamplingByServiceQuery,
	auditSamplingRowSchema,
	auditLogSeverityByServiceQuery,
	auditLogSeverityRowSchema,
	auditMetricLabelCardinalityQuery,
	auditMetricLabelRowSchema,
	auditPeerValueInventoryQuery,
	auditPeerValueRowSchema,
	auditDbEdgeIdentityQuery,
	auditDbEdgeRowSchema,
	auditLogCorrelationQuery,
	auditLogCorrelationRowSchema,
	auditOrphanSpansSQL,
	auditOrphanSpanRowSchema,
	auditRootlessTracesSQL,
	auditRootlessTraceRowSchema,
	auditTraceSampleModulus,
	AUDIT_LOG_CORRELATION_MAX_HOURS,
	AUDIT_PEER_KEYS,
	type AuditAttributeKeyRow,
	type AuditSpanProfileRow,
	type AuditSamplingRow,
	type AuditLogSeverityRow,
	type AuditMetricLabelRow,
	type AuditPeerValueRow,
	type AuditDbEdgeRow,
	type AuditLogCorrelationRow,
	type AuditOrphanSpanRow,
	type AuditRootlessTraceRow,
	type AuditTraceWindowParams,
} from "./setup-audit"

export {
	dailyProductEventCountQuery,
	dailyProductEventCountRowSchema,
	dailySessionCountQuery,
	dailySessionCountRowSchema,
	dailySignalVolumeQuery,
	dailySignalVolumeRowSchema,
	type DailySessionCountOutput,
	type DailySignalVolumeOutput,
} from "./billing-usage"

export {
	dbStatementSamplesQuery,
	type DbStatementSamplesOpts,
	type DbStatementSamplesOutput,
} from "./internal"
