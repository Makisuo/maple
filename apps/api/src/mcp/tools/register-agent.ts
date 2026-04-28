import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"

const parseCapabilities = (raw: string | undefined): ReadonlyArray<string> => {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((v): v is string => typeof v === "string")
	} catch {
		return []
	}
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
			const tenant = yield* resolveTenant
			if (tenant.actorId) {
				return validationError(
					"register_agent must be called from a human session, not an agent API key.",
				)
			}
			if (name.trim().length === 0) {
				return validationError("Agent name must not be empty.")
			}

			const errors = yield* ErrorsService
			const capabilities = parseCapabilities(capabilities_json)
			const actor = yield* errors
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
								pipe: "register_agent",
								cause: error,
							}),
					),
				)

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
