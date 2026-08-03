import {
	McpQueryError,
	optionalBooleanParam,
	optionalStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { formatNumber, formatTable } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { resolveTimeRange } from "@/mcp/lib/time"
import { RecommendationIssueService } from "@/services/RecommendationIssueService"
import { RecommendationIssueStatus, type RecommendationIssueKind } from "@maple/domain/http"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { makeWarehouseExecutorFromTenant } from "@/lib/WarehouseQueryService"

const decodeStatus = Schema.decodeUnknownOption(RecommendationIssueStatus)

export type RecommendationSeverity = "warn" | "info"

/**
 * Severity for the audit report. Renames and double-emissions degrade querying
 * (deprecated keys, split data) but Maple's fallback chains keep features working,
 * so nothing here is critical; naming advisories are stylistic.
 */
export const kindToSeverity = (kind: RecommendationIssueKind): RecommendationSeverity =>
	kind === "naming" ? "info" : "warn"

interface CoverageCheck {
	readonly checkId: string
	/** The gap is reported only when none of these resource keys arrive. */
	readonly keys: ReadonlyArray<string>
	readonly label: string
	readonly reason: string
}

// Org-wide resource-attribute presence checks. Check ids match skills/maple-audit/checks.md.
const COVERAGE_CHECKS: ReadonlyArray<CoverageCheck> = [
	{
		checkId: "RES-02",
		keys: ["service.version"],
		label: "service.version",
		reason: "No per-version slices on service overview.",
	},
	{
		checkId: "RES-03",
		keys: ["deployment.environment", "deployment.environment.name"],
		label: "deployment.environment(.name)",
		reason: "Environment filtering and per-env metrics are empty everywhere.",
	},
	{
		checkId: "RES-04",
		keys: ["vcs.repository.url.full"],
		label: "vcs.repository.url.full",
		reason: "Telemetry can't be linked back to the source repository.",
	},
	{
		checkId: "RES-05",
		keys: ["vcs.ref.head.revision"],
		label: "vcs.ref.head.revision",
		reason: "No release markers or per-deploy metrics.",
	},
]

export interface CoverageGap {
	readonly checkId: string
	readonly attribute: string
	readonly severity: "warn"
	readonly reason: string
}

/** Pure: which recommended resource attributes are absent from the org's live resource keys. */
export const deriveCoverageGaps = (
	resourceKeys: ReadonlyArray<{ readonly key: string }>,
): ReadonlyArray<CoverageGap> => {
	const present = new Set(resourceKeys.map((row) => row.key))
	return COVERAGE_CHECKS.filter((check) => !check.keys.some((key) => present.has(key))).map((check) => ({
		checkId: check.checkId,
		attribute: check.label,
		severity: "warn" as const,
		reason: check.reason,
	}))
}

// v2 candidates (each needs a new warehouse aggregate, deliberately not in v1):
// per-service coverage gaps, Client/Producer spans missing peer.service, and
// log records missing TraceId correlation.

export function registerGetInstrumentationRecommendationsTool(server: McpToolRegistrar) {
	server.tool(
		"get_instrumentation_recommendations",
		"Audit instrumentation quality for the org: lists detected span attribute issues reconciled against live data " +
			"(deprecated semconv keys to rename, double-emitted old+new keys, non-conforming names) plus org-wide " +
			"resource-attribute coverage gaps (deployment environment, vcs.*, service.version). Renames can be fixed at " +
			"the SDK or by accepting the matching Recommendation Issue in Maple Settings → Ingestion (creates an ingest " +
			"attribute mapping); double-emission and naming issues must be fixed at the SDK. Used by the maple-audit skill.",
		Schema.Struct({
			status: optionalStringParam(
				"Filter issues by status: open, dismissed, applied, resolved, or all (default: open)",
			),
			include_coverage: optionalBooleanParam(
				"Set to false to skip the resource-attribute coverage section (default: included)",
			),
		}),
		Effect.fn("McpTool.getInstrumentationRecommendations")(function* ({ status, include_coverage }) {
			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				status: status ?? "open",
			})

			let statusFilter: RecommendationIssueStatus | undefined = "open"
			if (status === "all") {
				statusFilter = undefined
			} else if (status) {
				const decoded = decodeStatus(status)
				if (Option.isNone(decoded)) {
					return validationError(
						`Invalid status: '${status}'. Must be one of: open, dismissed, applied, resolved, all.`,
					)
				}
				statusFilter = decoded.value
			}

			// Reconciles live span keys against persisted issues — calling this tool refreshes
			// usage counts and auto-resolves fixed issues, same as the dashboard settings page.
			const service = yield* RecommendationIssueService
			const reconciled = yield* service.listReconciled(tenant).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "get_instrumentation_recommendations",
							cause: error,
						}),
				),
			)

			const issues = reconciled.issues.filter(
				(issue) => statusFilter === undefined || issue.status === statusFilter,
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", issues.length)

			// Coverage degrades gracefully: if the warehouse is unavailable the issue list
			// (possibly stale) still renders, with the coverage section marked unavailable.
			const wantCoverage = include_coverage !== false
			const range = resolveTimeRange(undefined, undefined, { defaultHours: 24 })
			const resourceKeysOpt = wantCoverage
				? yield* exploreAttributeKeys({
						source: "traces",
						scope: "resource",
						timeRange: { startTime: range.st, endTime: range.et },
						limit: 500,
					}).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
						Effect.mapError(toMcpQueryError("get_instrumentation_recommendations")),
						Effect.option,
					)
				: Option.none()

			const coverageGaps = Option.isSome(resourceKeysOpt)
				? deriveCoverageGaps(resourceKeysOpt.value)
				: []

			const lines: string[] = [
				`## Instrumentation Recommendations`,
				`Status filter: ${status ?? "open"} · ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
				``,
			]

			if (issues.length === 0) {
				lines.push("No attribute issues detected in the last 24h of span data.")
			} else {
				lines.push(
					formatTable(
						["#", "Kind", "Severity", "Key", "Canonical", "Usage (24h)", "Status", "Fix via"],
						issues.map((issue) => [
							`#${issue.number}`,
							issue.kind,
							kindToSeverity(issue.kind),
							issue.sourceKey,
							issue.canonicalKey ?? "—",
							formatNumber(issue.usageCount),
							issue.status,
							issue.kind === "rename" ? "SDK or ingest mapping" : "SDK only",
						]),
					),
				)
			}

			if (wantCoverage) {
				lines.push(``, `### Resource attribute coverage (last 24h)`)
				if (Option.isNone(resourceKeysOpt)) {
					lines.push("Coverage check unavailable — warehouse query failed.")
				} else if (coverageGaps.length === 0) {
					lines.push("All recommended resource attributes are arriving. ✓")
				} else {
					lines.push(
						formatTable(
							["Check", "Missing attribute", "Severity", "Impact"],
							coverageGaps.map((gap) => [gap.checkId, gap.attribute, gap.severity, gap.reason]),
						),
					)
				}
			}

			const nextSteps: string[] = [
				`\`explore_attributes source="traces" scope="resource"\` — see every resource attribute key arriving`,
			]
			if (issues.some((issue) => issue.kind === "rename")) {
				nextSteps.push(
					"Rename issues: fix at the SDK (preferred) or accept the issue in Maple Settings → Ingestion to create an ingest attribute mapping",
				)
			}
			if (issues.some((issue) => issue.kind === "double-emission")) {
				nextSteps.push(
					"Double-emission issues: standardize on the canonical key at the SDK — a mapping can't merge keys",
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_instrumentation_recommendations",
					data: {
						issues: issues.map((issue) => ({
							id: issue.id,
							number: issue.number,
							recommendationKey: issue.recommendationKey,
							kind: issue.kind,
							severity: kindToSeverity(issue.kind),
							sourceKey: issue.sourceKey,
							canonicalKey: issue.canonicalKey ?? null,
							status: issue.status,
							usageCount: issue.usageCount,
							applyableAsMapping: issue.kind === "rename",
							openedAt: issue.openedAt,
							updatedAt: issue.updatedAt,
						})),
						coverage: {
							available: Option.isSome(resourceKeysOpt),
							included: wantCoverage,
							timeRange: { start: range.st, end: range.et },
							gaps: coverageGaps,
						},
						total: issues.length,
					},
				}),
			}
		}),
	)
}
