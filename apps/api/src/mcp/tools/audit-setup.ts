import { McpQueryError, optionalBooleanParam, type McpToolRegistrar } from "./types"
import { formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-warehouse"
import type { AuditCheckResult, AuditSeverity } from "@maple/domain/setup-audit"
import { SetupAuditService } from "@/services/SetupAuditService"

/** Fail-first, then by severity, so the table's top rows are the ones worth acting on. */
const SEVERITY_RANK: Record<AuditSeverity, number> = { critical: 0, warn: 1, info: 2 }
const STATUS_RANK: Record<AuditCheckResult["status"], number> = { fail: 0, skip: 1, pass: 2 }

export const byUrgency = (a: AuditCheckResult, b: AuditCheckResult) =>
	STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
	SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
	a.id.localeCompare(b.id)

/** Affected entities inline into the table cell — the agent reads them as evidence, not as a list. */
export const formatAffected = (check: AuditCheckResult): string => {
	if (check.affected.length === 0) return "—"
	const shown = check.affected
		.slice(0, 3)
		.map((entity) => (entity.note ? `${entity.name} (${entity.note})` : entity.name))
		.join("; ")
	const hidden = check.affectedCount - Math.min(check.affected.length, 3)
	return truncate(hidden > 0 ? `${shown}; +${hidden} more` : shown, 160)
}

export function registerAuditSetupTool(server: McpToolRegistrar) {
	server.tool(
		"audit_setup",
		"Audit the organization's whole Maple setup and report every check with its outcome. Covers alert routing and " +
			"delivery health (rules that will never notify anyone), error-notification wiring, what each service is " +
			"actually ingesting (traces/logs/metrics coverage, service.name mismatches), attribute and semantic-convention " +
			"quality, trace completeness (spans whose parent never arrived, traces with no root), and integration health. " +
			"Configuration checks always run; telemetry-backed checks report 'skip' when the warehouse is unavailable. " +
			"Each finding carries a stable check id, a severity, the affected objects and a fix hint. Use this to answer " +
			"'is my Maple setup correct' or 'why didn't anything alert me'; use get_instrumentation_recommendations for " +
			"the per-attribute rename list.",
		Schema.Struct({
			include_passing: optionalBooleanParam(
				"Include passing and skipped checks in the table (default: false — only findings are listed)",
			),
		}),
		Effect.fn("McpTool.auditSetup")(function* ({ include_passing }) {
			const tenant = yield* resolveTenant
			const service = yield* SetupAuditService
			const report = yield* service.run(tenant).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "audit_setup",
							cause: error,
						}),
				),
			)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"audit.dataStatus": report.dataStatus,
				"audit.critical": report.summary.critical,
				"audit.warn": report.summary.warn,
				"result.rowCount": report.checks.length,
			})

			const lines: string[] = ["## Setup Audit"]

			if (report.dataStatus === "no_data") {
				lines.push(
					"",
					"This organization has never received telemetry, so no checks were run. Connect a service first — " +
						"Settings → Ingestion has the endpoint and keys.",
				)
				return {
					content: createDualContent(lines.join("\n"), {
						tool: "audit_setup",
						data: toStructured(report),
					}),
				}
			}

			const { summary } = report
			lines.push(
				`${summary.critical} critical · ${summary.warn} warn · ${summary.info} info · ${summary.pass} passing · ${summary.skip} skipped`,
			)
			if (!report.warehouseAvailable) {
				lines.push(
					"",
					"⚠️ Telemetry could not be read, so every telemetry-backed check was skipped. The configuration findings below still apply.",
				)
			}
			lines.push("")

			const showAll = include_passing === true
			const visible = [...report.checks]
				.filter((check) => showAll || check.status === "fail")
				.sort(byUrgency)

			if (visible.length === 0) {
				lines.push("No findings — every check passed. ✓")
			} else {
				lines.push(
					formatTable(
						["Check", "Severity", "Status", "Finding", "Affected", "Fix"],
						visible.map((check) => [
							check.id,
							check.severity,
							check.status,
							truncate(check.detail ?? check.title, 200),
							formatAffected(check),
							truncate(check.fixHint, 160),
						]),
					),
				)
			}

			if (!showAll && (summary.pass > 0 || summary.skip > 0)) {
				lines.push(
					"",
					`${summary.pass} passing and ${summary.skip} skipped checks hidden — pass \`include_passing=true\` to see them.`,
				)
			}

			const nextSteps: string[] = []
			if (summary.critical > 0) {
				nextSteps.push("Fix the `critical` rows first — each one breaks a Maple feature outright")
			}
			if (report.openRecommendationCount > 0) {
				nextSteps.push(
					`\`get_instrumentation_recommendations\` — ${report.openRecommendationCount} open attribute recommendation(s) with the exact renames`,
				)
			}
			if (report.checks.some((check) => check.category === "traces" && check.status === "fail")) {
				nextSteps.push(
					"`inspect_trace` on one of the sampled trace ids above to see the gap in a real waterfall",
				)
			}
			if (nextSteps.length > 0) lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "audit_setup",
					data: toStructured(report),
				}),
			}
		}),
	)
}

const toStructured = (report: {
	generatedAt: number
	dataStatus: "ok" | "no_data"
	warehouseAvailable: boolean
	summary: { critical: number; warn: number; info: number; pass: number; skip: number }
	checks: ReadonlyArray<AuditCheckResult>
	openRecommendationCount: number
}) => ({
	generatedAt: new Date(report.generatedAt).toISOString(),
	dataStatus: report.dataStatus,
	telemetryChecksAvailable: report.warehouseAvailable,
	summary: report.summary,
	checks: report.checks.map((check) => ({
		id: check.id,
		category: check.category,
		title: check.title,
		severity: check.severity,
		status: check.status,
		detail: check.detail,
		affected: check.affected.map((entity) => ({
			kind: entity.kind,
			name: entity.name,
			note: entity.note ?? null,
		})),
		affectedCount: check.affectedCount,
		fixHint: check.fixHint,
	})),
	openRecommendationCount: report.openRecommendationCount,
})
