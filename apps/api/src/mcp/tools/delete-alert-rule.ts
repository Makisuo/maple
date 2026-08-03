import { McpQueryError, requiredBooleanParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { AlertsService } from "@/services/alerts/AlertsService"
import { AlertRuleId } from "@maple/domain"

const decodeAlertRuleId = Schema.decodeUnknownOption(AlertRuleId)

export function registerDeleteAlertRuleTool(server: McpToolRegistrar) {
	server.tool(
		"delete_alert_rule",
		"Permanently delete an alert rule. This is irreversible and also deletes the rule's incident history, " +
			"delivery events, and evaluation state. Requires confirm=true. Use list_alert_rules to find rule IDs.",
		Schema.Struct({
			rule_id: requiredStringParam("Alert rule ID to delete (use list_alert_rules to find IDs)"),
			confirm: requiredBooleanParam(
				"Must be true to confirm permanent deletion. This also deletes the rule's incident history, " +
					"delivery events, and evaluation state — irreversible.",
			),
		}),
		Effect.fn("McpTool.deleteAlertRule")(function* ({ rule_id, confirm }) {
			if (confirm !== true) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Deletion not confirmed. Re-call delete_alert_rule with confirm=true to permanently delete rule ${rule_id} and its incident history.`,
						},
					],
				}
			}

			const ruleId = decodeAlertRuleId(rule_id)
			if (Option.isNone(ruleId)) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Alert rule not found: ${rule_id}. Use list_alert_rules to find available rule IDs.`,
						},
					],
				}
			}

			const tenant = yield* resolveTenant
			const alerts = yield* AlertsService

			const result = yield* alerts.deleteRule(tenant.orgId, tenant.roles, ruleId.value).pipe(
				Effect.catchTags({
					"@maple/http/errors/AlertForbiddenError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}`,
								pipeName: "delete_alert_rule",
								cause: error,
							}),
						),
					"@maple/http/errors/AlertPersistenceError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}`,
								pipeName: "delete_alert_rule",
								cause: error,
							}),
						),
					"@maple/http/errors/AlertNotFoundError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}. Use list_alert_rules to find available rule IDs.`,
								pipeName: "delete_alert_rule",
								cause: error,
							}),
						),
				}),
			)

			return {
				content: createDualContent([`## Alert Rule Deleted`, `ID: ${result.id}`].join("\n"), {
					tool: "delete_alert_rule",
					data: { id: result.id },
				}),
			}
		}),
	)
}
