import type { AgentTool } from "@electric-ax/agents-runtime"
import { getMapleAgentSetup, type MapleAgentSetup } from "@maple/api/agent"
import { requiresApproval } from "@maple/ai"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Type, type TSchema } from "@mariozechner/pi-ai"
import type { z } from "zod"
import type { ApprovalRequestRowSchema } from "./maple-chat"

type ApprovalRow = z.infer<typeof ApprovalRequestRowSchema>

export interface MapleToolApprovalSink {
	readonly entityUrl: string
	readonly approvalRequests: {
		readonly insert: (row: ApprovalRow) => void
	}
}

interface MapleToolsOptions {
	readonly env: Record<string, unknown>
	readonly orgId: string
}

const internalServiceToken = (env: Record<string, unknown>): string => {
	const raw = env.INTERNAL_SERVICE_TOKEN
	if (typeof raw !== "string" || raw.length === 0) {
		throw new Error(
			"INTERNAL_SERVICE_TOKEN is not configured. Maple tools cannot authenticate against the API.",
		)
	}
	return raw
}

const createInternalToolRequest = (orgId: string, token: string) =>
	new Request("https://maple-agents.internal/mcp", {
		headers: {
			Authorization: `Bearer maple_svc_${token}`,
			"X-Org-Id": orgId,
		},
	})

const buildRequestLayer = (env: Record<string, unknown>, orgId: string) =>
	Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(createInternalToolRequest(orgId, internalServiceToken(env))),
	)

const toolResultText = (result: {
	readonly content: ReadonlyArray<{ readonly text: string }>
	readonly isError?: boolean
}): string => result.content.map((entry) => entry.text).join("\n\n")

const decodeToolInput = (
	schema: Schema.Top,
	input: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } => {
	try {
		const decoded = Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>)(input)
		return { ok: true, value: decoded }
	} catch (error) {
		return {
			ok: false,
			error: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

const runToolEffect = async (
	setup: MapleAgentSetup,
	definition: MapleAgentSetup["mapleToolDefinitions"][number],
	decoded: unknown,
	requestLayer: Layer.Layer<HttpServerRequest.HttpServerRequest>,
	signal: AbortSignal | undefined,
) => {
	const effect = (definition.handler as (input: unknown) => Effect.Effect<unknown, unknown, HttpServerRequest.HttpServerRequest>)(decoded).pipe(
		Effect.provide(requestLayer),
	)
	const exit = await setup.runtime.runPromiseExit(effect, signal ? { signal } : undefined)
	return Exit.match(exit, {
		onSuccess: (value) =>
			({ ok: true as const, value: value as { content: ReadonlyArray<{ text: string }>; isError?: boolean } }),
		onFailure: (cause) => ({ ok: false as const, error: Cause.pretty(cause) }),
	})
}

// Exported for unit tests so callers can build an AgentTool without bringing
// up the full Effect runtime via getMapleAgentSetup.
export const buildMapleAgentTool = (
	definition: MapleAgentSetup["mapleToolDefinitions"][number],
	deps: {
		readonly setup: MapleAgentSetup
		readonly approvalSink: MapleToolApprovalSink
		readonly requestLayer: Layer.Layer<HttpServerRequest.HttpServerRequest>
	},
): AgentTool => {
	const parameters = Type.Unsafe(deps.setup.toInputSchema(definition.schema)) as TSchema
	return {
		name: definition.name,
		label: definition.name.replace(/_/g, " "),
		description: definition.description,
		parameters,
		execute: async (toolCallId, input, signal) => {
			const decoded = decodeToolInput(definition.schema, input)
			if (!decoded.ok) {
				throw new Error(decoded.error)
			}

			if (requiresApproval(definition.name)) {
				const approvalId = `${deps.approvalSink.entityUrl}:${toolCallId}`
				deps.approvalSink.approvalRequests.insert({
					id: approvalId,
					toolCallId,
					toolName: definition.name,
					args: decoded.value,
					status: "pending",
					createdAt: Date.now(),
				})
				return {
					content: [{ type: "text", text: `Approval required for ${definition.name}.` }],
					details: {
						status: "approval_required",
						approvalId,
						toolName: definition.name,
					},
					terminate: true,
				}
			}

			const result = await runToolEffect(
				deps.setup,
				definition,
				decoded.value,
				deps.requestLayer,
				signal,
			)
			if (!result.ok) throw new Error(result.error)
			return {
				content: [{ type: "text", text: toolResultText(result.value) }],
				details: result.value,
			}
		},
	}
}

export const createMapleElectricTools = async (
	approvalSink: MapleToolApprovalSink,
	{ env, orgId }: MapleToolsOptions,
): Promise<Array<AgentTool>> => {
	const setup = await getMapleAgentSetup(env, { database: "libsql" })
	const requestLayer = buildRequestLayer(env, orgId)
	return setup.mapleToolDefinitions.map((definition) =>
		buildMapleAgentTool(definition, { setup, approvalSink, requestLayer }),
	)
}

export const executeApprovedMapleTool = async (
	env: Record<string, unknown>,
	orgId: string,
	toolName: string,
	args: unknown,
): Promise<string> => {
	const setup = await getMapleAgentSetup(env, { database: "libsql" })
	const definition = setup.mapleToolDefinitions.find((tool) => tool.name === toolName)
	if (!definition) throw new Error(`Unknown Maple tool "${toolName}"`)

	const requestLayer = buildRequestLayer(env, orgId)
	const decoded = decodeToolInput(definition.schema, args)
	if (!decoded.ok) throw new Error(decoded.error)

	const result = await runToolEffect(setup, definition, decoded.value, requestLayer, undefined)
	if (!result.ok) throw new Error(result.error)
	return toolResultText(result.value)
}
