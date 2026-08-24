import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveActorId } from "@/mcp/lib/resolve-actor"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

const decodeStringArray = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const parseArtifactList = (raw: string | undefined): ReadonlyArray<string> => {
	if (!raw) return []
	return Option.getOrElse(decodeStringArray(raw), () => [])
}

export function registerProposeFixTool(server: McpToolRegistrar) {
	server.tool(
		"propose_fix",
		[
			"Record a fix you are proposing for an error issue — a patch summary, optionally a PR URL and supporting artifacts — and move the issue to `in_review`.",
			"Claims the issue for you and walks it there from wherever it is, so you do not need `claim_error_issue` or `transition_error_issue` first; it fails if another agent already holds the issue, or if `pr_url` is not a GitHub pull request URL.",
			"Passing `pr_url` also links the PR, so this is the only tool you need when you have just opened one; use `link_pull_request` for a PR that already exists and needs no new proposal.",
			"Once a linked PR merges, Maple watches the error for a window sized by its severity and rate, then closes the issue itself if it stopped. Do not transition to `done` by hand.",
		].join(" "),
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			patch_summary: requiredStringParam("Short description of the proposed fix (1..4000 chars)"),
			pr_url: optionalStringParam("Link to PR, diff, or patch"),
			artifacts_json: optionalStringParam("JSON array of artifact URLs (logs, traces, analysis docs)"),
		}),
		Effect.fn("McpTool.proposeFix")(function* ({ issue_id, patch_summary, pr_url, artifacts_json }) {
			const tenant = yield* CurrentMcpTenant
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
								pipeName: "propose_fix",
								cause: error,
							}),
					),
				)

			// Say what happens next, because "State: in_review" does not convey that
			// nobody should touch the issue again until the PR merges.
			const lines = [
				`## Fix proposed`,
				`- Issue: ${issue.id}`,
				`- State: ${issue.workflowState}`,
				`- Held by you until you release it or the issue closes`,
				pr_url ? `- PR: ${pr_url}` : null,
				pr_url
					? `- When that PR merges, Maple verifies the fix against real traffic and closes the issue if the error stopped. Don't transition it to 'done' yourself.`
					: `- No PR attached, so nothing will verify this fix. Call link_pull_request when you open one.`,
			].filter((l): l is string => l !== null)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "propose_fix",
					data: {
						issueId: issue.id,
						workflowState: issue.workflowState,
						prUrl: pr_url ?? null,
					},
				}),
			}
		}),
	)
}
