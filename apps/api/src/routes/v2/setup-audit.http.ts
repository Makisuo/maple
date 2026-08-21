import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, PublicIdPrefixes, encodePublicId } from "@maple/domain/http/v2"
import type { PublicIdPrefix, V2SetupAudit, V2SetupAuditAffectedEntity } from "@maple/domain/http/v2"
import type { AuditAffectedEntity, AuditCheckResult, SetupAuditReport } from "@maple/domain/setup-audit"
import { Effect } from "effect"
import { SetupAuditService } from "@/services/org/SetupAuditService"

/**
 * Affected-entity kinds that map onto a v2 public ID. Repositories and integrations are deliberately
 * absent: they are not addressable resources in the v2 API, so minting prefixes for them would
 * promise a `GET` that does not exist. Those entities ship with `id: null`.
 */
const PUBLIC_ID_PREFIX_BY_KIND: Partial<Record<AuditAffectedEntity["kind"], PublicIdPrefix>> = {
	alert_rule: PublicIdPrefixes.alertRule,
	alert_destination: PublicIdPrefixes.alertDestination,
	attribute_mapping: PublicIdPrefixes.attributeMapping,
	scrape_target: PublicIdPrefixes.scrapeTarget,
} satisfies Partial<Record<AuditAffectedEntity["kind"], PublicIdPrefix>>

const toV2Affected = (entity: AuditAffectedEntity): V2SetupAuditAffectedEntity => {
	const prefix = PUBLIC_ID_PREFIX_BY_KIND[entity.kind]
	return {
		kind: entity.kind,
		id: prefix !== undefined && entity.id !== undefined ? encodePublicId(prefix, entity.id) : null,
		name: entity.name,
		note: entity.note ?? null,
	}
}

const toV2Check = (check: AuditCheckResult): V2SetupAudit["checks"][number] => ({
	object: "setup_audit_check",
	id: check.id,
	category: check.category,
	title: check.title,
	severity: check.severity,
	status: check.status,
	detail: check.detail,
	affected: check.affected.map(toV2Affected),
	affected_count: check.affectedCount,
	fix_hint: check.fixHint,
})

const toV2SetupAudit = (report: SetupAuditReport): V2SetupAudit => ({
	object: "setup_audit",
	generated_at: new Date(report.generatedAt).toISOString(),
	data_status: report.dataStatus,
	telemetry_checks_available: report.warehouseAvailable,
	summary: report.summary,
	checks: report.checks.map(toV2Check),
	open_recommendation_count: report.openRecommendationCount,
})

export const HttpV2InstrumentationAuditLive = HttpApiBuilder.group(
	MapleApiV2,
	"instrumentationAudit",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* SetupAuditService

			return handlers.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Only a configuration read failure reaches here — a warehouse outage degrades to
					// skipped checks inside the service rather than failing the request.
					const report = yield* service.run(tenant)
					return toV2SetupAudit(report)
				}),
			)
		}),
)
