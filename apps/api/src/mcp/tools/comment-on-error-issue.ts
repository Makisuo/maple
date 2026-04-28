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

export function registerCommentOnErrorIssueTool(server: McpToolRegistrar) {
	server.tool(
		"comment_on_error_issue",
		"Add a comment to the issue's timeline. Use kind='agent_note' for automated reasoning steps (visible in the audit log but styled differently in the UI).",
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			body: requiredStringParam("Comment body (markdown supported)"),
			kind: optionalStringParam("'comment' (default) or 'agent_note'"),
			visibility: optionalStringParam("'internal' (default) or 'public'"),
		}),
		Effect.fn("McpTool.commentOnErrorIssue")(function* ({ issue_id, body, kind, visibility }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			if (body.trim().length === 0) {
				return validationError("Comment body must not be empty.")
			}
			const kindTyped: "comment" | "agent_note" = kind === "agent_note" ? "agent_note" : "comment"
			const visibilityTyped: "internal" | "public" | undefined =
				visibility === "public" ? "public" : visibility === "internal" ? "internal" : undefined

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const event = yield* errors
				.commentOnIssue(tenant.orgId, actorId, decodedIssueId.value, body, {
					kind: kindTyped,
					visibility: visibilityTyped,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipe: "comment_on_error_issue",
								cause: error,
							}),
					),
				)

			const lines = [
				`## Comment added`,
				`- Issue: ${event.issueId}`,
				`- Kind: ${event.type}`,
				`- Actor: ${event.actor?.agentName ?? event.actor?.userId ?? actorId}`,
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "comment_on_error_issue",
					data: {
						eventId: event.id,
						issueId: event.issueId,
						type: kindTyped,
						actorId: event.actor?.id ?? null,
					},
				}),
			}
		}),
	)
}
