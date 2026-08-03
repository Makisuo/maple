import {
	McpQueryError,
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { AlertDestinationId, AlertSeverity, ErrorNotificationPolicyUpsertRequest } from "@maple/domain/http"

const decodeSeverity = Schema.decodeUnknownOption(AlertSeverity)
const decodeDestinationId = Schema.decodeUnknownEffect(AlertDestinationId)

export function registerUpdateErrorNotificationPolicyTool(server: McpToolRegistrar) {
	server.tool(
		"update_error_notification_policy",
		"Configure the org-wide error notification policy. Controls whether incidents (first-seen, regression, auto-resolve) dispatch to alert destinations. Omit a field to leave it unchanged.",
		Schema.Struct({
			enabled: optionalBooleanParam("Enable notifications overall"),
			destination_ids: optionalStringParam(
				"Comma-separated alert destination IDs to notify. Pass empty string to clear.",
			),
			notify_on_first_seen: optionalBooleanParam(
				"Notify on the first-ever occurrence of an error fingerprint",
			),
			notify_on_regression: optionalBooleanParam("Notify when a resolved issue re-occurs"),
			notify_on_resolve: optionalBooleanParam(
				"Notify when an incident is auto-resolved after the silence window",
			),
			min_occurrence_count: optionalNumberParam(
				"Only notify when the opening occurrence count meets this threshold (default 1)",
			),
			severity: optionalStringParam("Severity label attached to notifications: warning or critical"),
		}),
		Effect.fn("McpTool.updateErrorNotificationPolicy")(function* ({
			enabled,
			destination_ids,
			notify_on_first_seen,
			notify_on_regression,
			notify_on_resolve,
			min_occurrence_count,
			severity,
		}) {
			// `severity` is optional; when present it must decode to a valid
			// AlertSeverity. Model the parsed-or-absent value as an Option.
			const parsedSeverity =
				severity === undefined ? Option.none<AlertSeverity>() : decodeSeverity(severity)
			if (severity !== undefined && Option.isNone(parsedSeverity)) {
				return validationError(`Invalid severity: ${severity}. Must be one of: warning, critical.`)
			}
			const decodedSeverity = Option.getOrUndefined(parsedSeverity)

			const tenant = yield* resolveTenant
			const errors = yield* ErrorsService

			const patch: Partial<{
				enabled: boolean
				destinationIds: ReadonlyArray<AlertDestinationId>
				notifyOnFirstSeen: boolean
				notifyOnRegression: boolean
				notifyOnResolve: boolean
				minOccurrenceCount: number
				severity: AlertSeverity
			}> = {}
			if (enabled !== undefined) patch.enabled = enabled
			if (destination_ids !== undefined) {
				const tokens = destination_ids
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
				patch.destinationIds = yield* Effect.forEach(tokens, (token) =>
					decodeDestinationId(token).pipe(
						Effect.mapError(
							(cause) =>
								new McpQueryError({
									message: `Invalid alert destination ID: ${token}`,
									pipeName: "update_error_notification_policy",
									cause,
								}),
						),
					),
				)
			}
			if (notify_on_first_seen !== undefined) patch.notifyOnFirstSeen = notify_on_first_seen
			if (notify_on_regression !== undefined) patch.notifyOnRegression = notify_on_regression
			if (notify_on_resolve !== undefined) patch.notifyOnResolve = notify_on_resolve
			if (min_occurrence_count !== undefined) patch.minOccurrenceCount = min_occurrence_count
			if (decodedSeverity !== undefined) patch.severity = decodedSeverity

			const decodedPatch = yield* Schema.decodeUnknownEffect(ErrorNotificationPolicyUpsertRequest)(
				patch,
			).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: `Invalid notification policy payload: ${String(error)}`,
							pipeName: "update_error_notification_policy",
							cause: error,
						}),
				),
			)

			const policy = yield* errors
				.upsertNotificationPolicy(tenant.orgId, tenant.userId, decodedPatch)
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorPersistenceError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: error.message,
									pipeName: "update_error_notification_policy",
									cause: error,
								}),
							),
						"@maple/http/errors/ErrorValidationError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: error.message,
									pipeName: "update_error_notification_policy",
									cause: error,
								}),
							),
					}),
				)

			const lines = [
				`## Error notification policy updated`,
				`- Enabled: ${policy.enabled ? "yes" : "no"}`,
				`- Destinations: ${
					policy.destinationIds.length > 0 ? policy.destinationIds.join(", ") : "—"
				}`,
				`- First seen: ${policy.notifyOnFirstSeen ? "yes" : "no"}`,
				`- Regression: ${policy.notifyOnRegression ? "yes" : "no"}`,
				`- Resolve: ${policy.notifyOnResolve ? "yes" : "no"}`,
				`- Min occurrence: ${policy.minOccurrenceCount}`,
				`- Severity: ${policy.severity}`,
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "update_error_notification_policy",
					data: {
						enabled: policy.enabled,
						destinationIds: policy.destinationIds,
						notifyOnFirstSeen: policy.notifyOnFirstSeen,
						notifyOnRegression: policy.notifyOnRegression,
						notifyOnResolve: policy.notifyOnResolve,
						minOccurrenceCount: policy.minOccurrenceCount,
						severity: policy.severity,
					},
				}),
			}
		}),
	)
}
