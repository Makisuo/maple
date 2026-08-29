import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"

const decodeStringArray = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const parseCapabilities = (raw: string | undefined): ReadonlyArray<string> => {
	if (!raw) return []
	return Option.getOrElse(decodeStringArray(raw), () => [])
}

export function registerRegisterAgentTool(server: McpToolRegistrar) {
	server.tool(
		"register_agent",
		"Register an LLM agent with the error-issue system so it can claim and transition issues. Must be called from a human session (not an agent API key). Returns an actor ID to pin via API-key metadata.",
		Schema.Struct({
			name: requiredStringParam("Unique agent name within the org (1..100 chars)"),
			model: optionalStringParam("Model identifier, e.g. 'claude-opus-4.7'"),
			capabilities_json: optionalStringParam(
				'JSON array of capability tags, e.g. ["auto-triage","patch-proposer"]',
			),
		}),
		Effect.fn("McpTool.registerAgent")(function* ({ name, model, capabilities_json }) {
			const tenant = yield* CurrentMcpTenant
			if (tenant.actorId) {
				return validationError(
					"register_agent must be called from a human session, not an agent API key.",
				)
			}
			if (name.trim().length === 0) {
				return validationError("Agent name must not be empty.")
			}

			const actors = yield* ErrorActorsService
			const capabilities = parseCapabilities(capabilities_json)
			const actor = yield* actors
				.registerAgent(tenant.orgId, tenant.userId, {
					name,
					model,
					capabilities,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "register_agent",
								cause: error,
							}),
					),
				)

			const audit = yield* AuditLogService
			yield* audit.record({
				orgId: tenant.orgId,
				actor: { type: "user", userId: tenant.userId },
				source: "mcp",
				action: "agent.registered",
				resourceType: "agent",
				resourceId: encodePublicId(PublicIdPrefixes.actor, actor.id),
				metadata: { name: actor.agentName ?? name },
			})

			const lines = [
				`## Agent registered`,
				`- Actor ID: ${actor.id}`,
				`- Name: ${actor.agentName ?? name}`,
				actor.model ? `- Model: ${actor.model}` : null,
				capabilities.length > 0 ? `- Capabilities: ${capabilities.join(", ")}` : null,
				``,
				`Next: pin this actor to an API key by storing { "agentActorId": "${actor.id}" } in the key's metadata, or pass \`x-maple-agent-id: ${actor.id}\` on tool requests.`,
			].filter((l): l is string => l !== null)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "register_agent",
					data: {
						id: actor.id,
						agentName: actor.agentName,
						model: actor.model,
						capabilities: actor.capabilities,
					},
				}),
			}
		}),
	)
}
