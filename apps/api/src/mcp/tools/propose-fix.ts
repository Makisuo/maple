import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveActorId } from "../lib/resolve-actor"
import { ErrorsService } from "@/services/ErrorsService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

const parseArtifactList = (raw: string | undefined): ReadonlyArray<string> => {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((v): v is string => typeof v === "string")
	} catch {
		return []
	}
}

export function registerProposeFixTool(server: McpToolRegistrar) {
	server.tool(
		"propose_fix",
		"Attach a fix proposal (PR URL, patch summary, artifacts) to an error issue. Transitions the issue to 'in_review'. The human owner can then accept (→ done) or reject.",
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			patch_summary: requiredStringParam("Short description of the proposed fix (1..4000 chars)"),
			pr_url: optionalStringParam("Link to PR, diff, or patch"),
			artifacts_json: optionalStringParam("JSON array of artifact URLs (logs, traces, analysis docs)"),
		}),
		Effect.fn("McpTool.proposeFix")(function* ({ issue_id, patch_summary, pr_url, artifacts_json }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			if (patch_summary.trim().length === 0) {
				return validationError("patch_summary must not be empty.")
			}

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const artifacts = parseArtifactList(artifacts_json)
			const issue = yield* errors
				.proposeFix(tenant.orgId, actorId, decodedIssueId.value, {
					patchSummary: patch_summary,
					prUrl: pr_url,
					artifacts,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipe: "propose_fix",
								cause: error,
							}),
					),
				)

			const lines = [
				`## Fix proposed`,
				`- Issue: ${issue.id}`,
				`- State: ${issue.workflowState}`,
				pr_url ? `- PR: ${pr_url}` : null,
			].filter((l): l is string => l !== null)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "propose_fix",
					data: {
						issueId: issue.id,
						workflowState: issue.workflowState,
						eventId: "",
						prUrl: pr_url ?? null,
					},
				}),
			}
		}),
	)
}
