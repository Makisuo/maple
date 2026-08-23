import { McpQueryError, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveActorId } from "@/mcp/lib/resolve-actor"
import { IssueFixVerificationService } from "@/services/errors/IssueFixVerificationService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

export function registerLinkPullRequestTool(server: McpToolRegistrar) {
	server.tool(
		"link_pull_request",
		[
			"Attach a GitHub pull request to an error issue.",
			"When that PR merges, Maple opens a verification window sized by the issue's severity and its own occurrence rate, then checks whether the error actually stopped — closing the issue automatically if it did.",
			"Use this when a fix already has a PR but you are not proposing it as new work; propose_fix does the same linking when you pass pr_url.",
		].join(" "),
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			pull_request_url: requiredStringParam(
				"Full GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123",
			),
		}),
		Effect.fn("McpTool.linkPullRequest")(function* ({ issue_id, pull_request_url }) {
			const tenant = yield* CurrentMcpTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}

			const actorId = yield* resolveActorId(tenant)
			const verification = yield* IssueFixVerificationService
			const link = yield* verification
				.linkPullRequest(tenant.orgId, actorId, decodedIssueId.value, pull_request_url, "agent")
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "link_pull_request",
								cause: error,
							}),
					),
				)

			const lines = [
				"## Pull request linked",
				`- Issue: ${link.issueId}`,
				`- PR: ${link.repoFullName}#${link.number}`,
				`- URL: ${link.url}`,
				`- State: ${link.state}`,
				link.state === "merged"
					? "- Already merged; verification is scheduled."
					: "- Verification starts when this PR merges.",
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "link_pull_request",
					data: {
						pullRequestId: link.id,
						issueId: link.issueId,
						repoFullName: link.repoFullName,
						number: link.number,
						url: link.url,
						state: link.state,
					},
				}),
			}
		}),
	)
}
