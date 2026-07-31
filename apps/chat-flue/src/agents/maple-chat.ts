"use agent"

import { useAgentStart, useModel, useTool, type AgentProps } from "@flue/runtime"
import type { InternalMcpToolDescriptor } from "@maple/domain/internal-rpc"
import { applyApprovalGates } from "../lib/approval.ts"
import { buildMapleTools, fetchMapleToolDescriptors, MCP_DEFAULT_TIMEOUT_MS } from "../lib/mcp.ts"
import { buildSystemPrompt, modeFromInstanceId } from "../lib/modes.ts"
import { investigationIdFromInstanceId, orgIdFromInstanceId } from "../lib/org.ts"
import { buildSubmitDiagnosisTool } from "../lib/submit-diagnosis.ts"
import { emitTelemetryLog } from "../lib/telemetry.ts"
import { telemetryEnv } from "../lib/telemetry-env.ts"

/**
 * Default Workers AI model. EXPERIMENT: trying Z.ai's `@cf/zai-org/glm-5.2`.
 * `cloudflare/<model-id>` is passed verbatim to `env.AI.run(...)`; an `@cf/*`
 * model is hosted natively on Workers AI — keyless and billed as normal Workers
 * AI usage (neurons + the daily free allocation), no partner/Unified Billing or
 * AI Gateway BYOK.
 *
 * Previous default: `cloudflare/@cf/moonshotai/kimi-k2.6` (validated). The
 * Workers AI catalog churns, so confirm the id against the live catalog if a
 * call 404s. Override per-org via `MAPLE_CHAT_MODEL`.
 */
const DEFAULT_MODEL = "cloudflare/@cf/zai-org/glm-5.2"

/**
 * Bindings, resolved once per isolate. An agent function renders synchronously
 * (and re-renders before every model call), so env cannot be awaited inside it.
 */
const env = await telemetryEnv()

/**
 * The Maple tool registry, cached per isolate.
 *
 * The registry is deployment-static — `listMcpTools` is a pure constant on the
 * API side — so one fetch per isolate serves every turn, instead of the
 * per-interaction round-trip the v1 agent factory paid (the leading "chat takes
 * ages to start" suspect). Priming happens in `useAgentStart`, which runs on
 * every delivery before the model reads it.
 */
let descriptorCache: readonly InternalMcpToolDescriptor[] | undefined

/**
 * The addressable Maple chat agent on Cloudflare Workers AI, with tools sourced
 * from Maple's MCP registry over the `MAPLE_API_RPC` service binding. Mode
 * (default / alert / widget-fix / dashboard-builder) is derived from the
 * instance id.
 *
 * Addressed from the browser as `POST /agents/maple-chat/<orgId>:<tabId>` —
 * mounted in `app.ts` with `createAgentRouter(MapleChat)`, which is also where
 * AuthN + per-instance authZ live.
 *
 * `agentName` pins the durable identity to `maple-chat`, which the Cloudflare
 * target folds into the Durable Object class `FlueMapleChatAgent` and binding
 * `FLUE_MAPLE_CHAT_AGENT` — the same names Flue 1 deployed, so existing
 * conversations keep their storage. Do not rename it.
 */
export function MapleChat({ id }: AgentProps) {
	const orgId = orgIdFromInstanceId(id)

	useModel(env.MAPLE_CHAT_MODEL ?? DEFAULT_MODEL)

	// Prime the registry off the render path. Tolerant of failure so the agent
	// still answers on Workers AI when the API RPC binding isn't wired up: a
	// throw here would fail the submission before the model ever runs.
	useAgentStart(async () => {
		if (descriptorCache || !orgId) return
		try {
			descriptorCache = await fetchMapleToolDescriptors(env, MCP_DEFAULT_TIMEOUT_MS)
		} catch (error) {
			emitTelemetryLog("error", "chat.mcp_connect_failed", {
				"error.type": error instanceof Error ? error.name : "UnknownError",
				"error.message": error instanceof Error ? error.message : String(error),
			})
		}
	})

	if (orgId && descriptorCache) {
		// Propose-then-apply: mutating tools return a proposal the UI approves.
		// Flue 2 still has no human-in-the-loop interrupt — a tool either returns
		// or throws — so the gate stays a tool wrapper.
		for (const tool of applyApprovalGates(buildMapleTools(env, orgId, descriptorCache))) {
			useTool(tool)
		}

		// Investigate mode: the autonomous diagnostic pass is the session's first
		// turn, capped off by a (non-gated) `submit_diagnosis` call that persists
		// the structured report. The id rides in the instance id, so the agent
		// never chooses which investigation it writes.
		const investigationId = investigationIdFromInstanceId(id)
		if (investigationId) useTool(buildSubmitDiagnosisTool(env, orgId, investigationId))
	}

	// Mode is derived from the instance id's tab-id prefix (alert- / widget-fix- /
	// dashboard-builder-). The rich per-conversation context payloads
	// (alertContext, widgetFixContext, pageContext) arrive from the web client as
	// a first-message preamble.
	return buildSystemPrompt({ mode: modeFromInstanceId(id) })
}

MapleChat.agentName = "maple-chat"
