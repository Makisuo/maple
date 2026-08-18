// Per-span vendor integrations for the AI read path.
//
// A normalized AI span is the raw span merged with the *facts* this module
// derives from its attributes. Dispatch is strictly per span on the stamped
// `AiVendor` slug — never per trace or per session: a single trace routinely
// mixes vendors (CrewAI orchestration spans parenting openinference-openai LLM
// spans is the proven normal case), and in that shape the token counts live on
// the child spans of a *different* vendor than the session-keyed ones.
//
// The base normalizer speaks standard `gen_ai.*` semconv. A vendor integration
// overrides only what its vendor spells differently; every field it does not
// return keeps the base's answer. Vendors without an integration — including
// the `unknown:*` buckets — run the base alone. Attribute spellings are
// verified against the trace-capture corpus (`trace-capture` repo), not docs:
// several vendors' docs disagree with their wire format.

export type AiSpanRole = "llm" | "tool" | "agent" | "workflow" | "other"

export interface AiSpanInput {
	/** The stamped `AiVendor` slug. Typed `string`, not `AiVendor`: a slug the
	 *  Rust classifier ships before this package redeploys must degrade to the
	 *  base normalizer, not throw. */
	readonly vendor: string
	readonly spanName: string
	readonly attributes: Readonly<Record<string, string>>
}

/** What the integration layer can know about an AI span. `null` = the vendor
 *  does not put this fact on this span (tokens live only on LLM-call spans,
 *  session keys only on session-authoritative ones). */
export interface AiSpanFacts {
	/** The five tiers a session rollup counts in: `llm` (a model call), `tool`,
	 *  `agent`, `workflow`, and `other` for everything with no tier of ours. */
	readonly role: AiSpanRole
	/** The operation name as the vendor spelled it, unmapped. `role` coarsens
	 *  this into five tiers; this keeps the distinction the tiers throw away
	 *  (`chat` vs `embeddings`, `workflow_step` vs `workflow_run`) and is the
	 *  only fact left for operations with no tier of ours (`retrieval`, the
	 *  memory family). */
	readonly operation: string | null
	/** Semconv's own provider discriminator (`anthropic`, `openai`, …). Not the
	 *  same question as our stamped `AiVendor`, which names the instrumentation:
	 *  a mastra span reports provider `openai`. */
	readonly providerName: string | null
	/** The model as the provider named it, response spelling preferred over the
	 *  request's: a request for `gpt-4o` is answered by `gpt-4o-2024-08-06`, and
	 *  the resolved one is what a cost or drift question needs. */
	readonly model: string | null
	/** Billed prompt tokens. INCLUDES the two cache counts below, so a total is
	 *  `input + output` and never adds them again. */
	readonly inputTokens: number | null
	/** Billed completion tokens; includes `reasoningTokens`. */
	readonly outputTokens: number | null
	/** Prompt tokens served from the provider's cache. A subset of `inputTokens`. */
	readonly cacheReadTokens: number | null
	/** Prompt tokens written to the provider's cache. A subset of `inputTokens`. */
	readonly cacheCreationTokens: number | null
	/** Thinking tokens. A SUBSET of `outputTokens` per spec, never an addend:
	 *  adding it into any total double-counts. Display only. */
	readonly reasoningTokens: number | null
	/** The provider's own cost figure in USD. `gen_ai.usage.cost` is a de-facto
	 *  vendor extension, not semconv — most exporters omit it and we do not
	 *  price tokens ourselves, so null is the common case. */
	readonly costUsd: number | null
	/** The plaintext session key, for display — the hash column is opaque. Lives
	 *  in span attributes under a vendor-specific key on the spans that carry it. */
	readonly sessionKey: string | null
	/** True when the agent compacted its context before this call. Spec says
	 *  instrumentations set it only when compaction was reliably detected and
	 *  never set it to false, so `false` is rare-but-possible wire data rather
	 *  than a promise that no compaction happened; null = nothing was exported. */
	readonly compacted: boolean | null
	/** The chained-context id this request continued from (OpenAI Responses
	 *  `previous_response_id`, Google Interactions `previous_interaction_id`) —
	 *  enough to stitch a session together when no conversation id exists. */
	readonly previousResponseId: string | null
	/** Names for the tiers `role` identifies. `agentId` is a *hosted* agent's
	 *  stable resource id (assistant id, Bedrock ARN) — semconv explicitly keeps
	 *  transient in-process instances out of it, so it is null on most spans. */
	readonly agentName: string | null
	readonly agentId: string | null
	/** Free-form agent description and the agent definition's version string. */
	readonly agentDescription: string | null
	readonly agentVersion: string | null
	readonly workflowName: string | null
	/** Tool-span identity. `toolCallId` is the provider's call id, which links
	 *  this execution back to its request part in the parent LLM span's output
	 *  messages; `toolType` is `function` | `extension` | `datastore`. */
	readonly toolName: string | null
	readonly toolCallId: string | null
	readonly toolType: string | null
	/** The tool's own description, as advertised to the model. */
	readonly toolDescription: string | null
	/** The tool list available to the model/agent on this call, as a raw JSON
	 *  string (same rationale as `inputText`: rendering is a UI concern).
	 *  Opt-in and potentially large. */
	readonly toolDefinitions: string | null
	/** The provider's completion id (`chatcmpl-…`) — the handle for quoting a
	 *  generation back to the provider. */
	readonly responseId: string | null
	/** Why each generation stopped (`["stop"]`, `["length"]`), one entry per
	 *  generation — truncation vs stop vs filter without parsing message JSON. */
	readonly finishReasons: readonly string[] | null
	/** Lifecycle of a possibly background/long-running generation. Well-known
	 *  values `queued`, `in_progress`, `completed`, `incomplete`, `failed`,
	 *  `cancelled`; custom values are allowed. Distinct from `finishReasons`,
	 *  which says why the model stopped once it produced output. */
	readonly responseStatus: string | null
	/** Seconds (double) from issuing the request to the first streamed chunk.
	 *  Only on streaming requests. */
	readonly timeToFirstChunk: number | null
	/** Provider error code, exception class name, or another low-cardinality
	 *  identifier, with `_OTHER` as the fallback. Set only when the operation
	 *  failed. Borrowed from the Stable `error.type`, not the `gen_ai.*` family. */
	readonly errorType: string | null
	/** The system prompt, raw, for APIs that take it separately from the chat
	 *  history. Opt-in and sensitive; instructions embedded in the history land
	 *  in `inputText` instead. */
	readonly systemInstructions: string | null
	/** Prompt-template identity: the registered template's name and version. */
	readonly promptName: string | null
	readonly promptVersion: string | null
	/** The template's variables, keyed by variable name with the serialized
	 *  value — collected from every `gen_ai.prompt.variable.*` attribute.
	 *  Opt-in; null when the span carries no such key. */
	readonly promptVariables: Readonly<Record<string, string>> | null
	/** Conversational content, as the vendor recorded it — the input side (chat
	 *  messages JSON, a plain prompt, tool-call arguments) and the output side
	 *  (messages JSON, response text, tool result). Raw strings on purpose: the
	 *  formats differ per vendor and rendering them is a UI concern; this layer
	 *  only knows WHICH attribute holds them. `null` = not exported. */
	readonly inputText: string | null
	readonly outputText: string | null
}

/** A vendor's overrides: mutable while being built, partial because every
 *  omitted field keeps the base's answer. */
type AiSpanFactOverrides = { -readonly [K in keyof AiSpanFacts]?: AiSpanFacts[K] }

type AiVendorIntegration = (span: AiSpanInput) => AiSpanFactOverrides

const num = (attrs: AiSpanInput["attributes"], key: string): number | null => {
	const raw = attrs[key]
	if (raw === undefined || raw === "") return null
	const value = Number(raw)
	return Number.isFinite(value) ? value : null
}

const str = (attrs: AiSpanInput["attributes"], key: string): string | null => {
	const raw = attrs[key]
	return raw === undefined || raw === "" ? null : raw
}

// Booleans reach us as the string map's `"true"` / `"false"`; anything else is
// not a boolean the exporter meant, so it reads as absent rather than falsey.
const bool = (attrs: AiSpanInput["attributes"], key: string): boolean | null => {
	const raw = attrs[key]
	return raw === "true" ? true : raw === "false" ? false : null
}

// Array-valued attributes reach us through a string map, so the collector's
// JSON encoding (`["stop","length"]`) is what lands. Not every exporter encodes
// though — a one-element list often arrives as the bare value — so anything
// that is not a JSON array of strings reads as a single element rather than
// being dropped.
const strArray = (attrs: AiSpanInput["attributes"], key: string): readonly string[] | null => {
	const raw = attrs[key]
	if (raw === undefined || raw === "") return null
	if (raw.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(raw)
			if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string"))
				return parsed
		} catch {
			// Not JSON after all; the raw string is still a value.
		}
	}
	return [raw]
}

// Template variables are one attribute per variable, so the only way to read
// them is a key scan: the suffix after the prefix is the variable name.
const PROMPT_VARIABLE_PREFIX = "gen_ai.prompt.variable."

const promptVariables = (
	attrs: AiSpanInput["attributes"],
): Readonly<Record<string, string>> | null => {
	let collected: Record<string, string> | null = null
	for (const [key, value] of Object.entries(attrs)) {
		if (!key.startsWith(PROMPT_VARIABLE_PREFIX)) continue
		collected ??= {}
		collected[key.slice(PROMPT_VARIABLE_PREFIX.length)] = value
	}
	return collected
}

// Semconv `gen_ai.operation.name` → role. Anything unlisted is "other" — an
// honest bucket, not a guess: `retrieval`, `fetch_response` and the memory
// family are real semconv operations with no tier of ours to land in, and
// forcing them into one would misreport every session rollup. `operation`
// keeps their exact name either way.
const SEMCONV_OPERATION_ROLES: Readonly<Record<string, AiSpanRole>> = {
	chat: "llm",
	text_completion: "llm",
	generate_content: "llm",
	embeddings: "llm",
	execute_tool: "tool",
	invoke_agent: "agent",
	create_agent: "agent",
	plan: "agent",
	invoke_workflow: "workflow",
}

const baseNormalize = ({ attributes }: AiSpanInput): AiSpanFacts => ({
	role: SEMCONV_OPERATION_ROLES[attributes["gen_ai.operation.name"] ?? ""] ?? "other",
	operation: str(attributes, "gen_ai.operation.name"),
	providerName: str(attributes, "gen_ai.provider.name"),
	model: str(attributes, "gen_ai.response.model") ?? str(attributes, "gen_ai.request.model"),
	inputTokens: num(attributes, "gen_ai.usage.input_tokens"),
	outputTokens: num(attributes, "gen_ai.usage.output_tokens"),
	cacheReadTokens: num(attributes, "gen_ai.usage.cache_read.input_tokens"),
	cacheCreationTokens: num(attributes, "gen_ai.usage.cache_creation.input_tokens"),
	reasoningTokens: num(attributes, "gen_ai.usage.reasoning.output_tokens"),
	costUsd: num(attributes, "gen_ai.usage.cost"),
	sessionKey: str(attributes, "gen_ai.conversation.id"),
	compacted: bool(attributes, "gen_ai.conversation.compacted"),
	previousResponseId: str(attributes, "gen_ai.request.previous_response.id"),
	agentName: str(attributes, "gen_ai.agent.name"),
	agentId: str(attributes, "gen_ai.agent.id"),
	agentDescription: str(attributes, "gen_ai.agent.description"),
	agentVersion: str(attributes, "gen_ai.agent.version"),
	workflowName: str(attributes, "gen_ai.workflow.name"),
	toolName: str(attributes, "gen_ai.tool.name"),
	toolCallId: str(attributes, "gen_ai.tool.call.id"),
	toolType: str(attributes, "gen_ai.tool.type"),
	toolDescription: str(attributes, "gen_ai.tool.description"),
	toolDefinitions: str(attributes, "gen_ai.tool.definitions"),
	responseId: str(attributes, "gen_ai.response.id"),
	finishReasons: strArray(attributes, "gen_ai.response.finish_reasons"),
	responseStatus: str(attributes, "gen_ai.response.status"),
	timeToFirstChunk: num(attributes, "gen_ai.response.time_to_first_chunk"),
	errorType: str(attributes, "error.type"),
	systemInstructions: str(attributes, "gen_ai.system_instructions"),
	promptName: str(attributes, "gen_ai.prompt.name"),
	promptVersion: str(attributes, "gen_ai.prompt.version"),
	promptVariables: promptVariables(attributes),
	inputText:
		str(attributes, "gen_ai.input.messages") ?? str(attributes, "gen_ai.tool.call.arguments"),
	outputText:
		str(attributes, "gen_ai.output.messages") ?? str(attributes, "gen_ai.tool.call.result"),
})

// mastra — tokens/model/session key are clean semconv; the one divergence is
// that `gen_ai.operation.name` doubles as Mastra's span-type field, so most of
// its values are not semconv operation names. `mastra.span.type` carries the
// same value and survives attribute-family degradation, so it is the input.
const mastraIntegration: AiVendorIntegration = ({ attributes }) => {
	const spanType = attributes["mastra.span.type"] ?? attributes["gen_ai.operation.name"] ?? ""
	const facts: AiSpanFactOverrides = {}
	// The span type IS mastra's operation name, and it is the spelling that
	// survives when the `gen_ai.*` family degrades away.
	if (spanType !== "") facts.operation = spanType
	if (spanType.startsWith("model_")) facts.role = "llm"
	else if (spanType.startsWith("workflow_") || spanType === "invoke_workflow")
		facts.role = "workflow"
	else if (spanType === "agent_run") facts.role = "agent"
	// Content rides under `mastra.<span type>.input` / `.output` on every span
	// type (agent_run, model_step, workflow_*); `chat` spans carry the semconv
	// messages instead, which the base already reads.
	const input = str(attributes, `mastra.${spanType}.input`)
	if (input !== null) facts.inputText = input
	const output = str(attributes, `mastra.${spanType}.output`)
	if (output !== null) facts.outputText = output
	return facts
}

// claude_agent_sdk — the whole dialect is bare, unnamespaced keys: `span.type`,
// `model`, `input_tokens`, `session.id`. (`gen_ai.request.model` also rides
// along, so the base covers model too; tokens and the session key do not.)
const CLAUDE_SPAN_TYPE_ROLES: Readonly<Record<string, AiSpanRole>> = {
	llm_request: "llm",
	tool: "tool",
	"tool.execution": "tool",
	"tool.blocked_on_user": "tool",
	// The per-turn root. `subagent.spawn` is unreachable in the shipped CLI but
	// named in the dialect; both are the agent tier.
	interaction: "agent",
	"subagent.spawn": "agent",
}

const claudeAgentSdkIntegration: AiVendorIntegration = ({ attributes }) => {
	const facts: AiSpanFactOverrides = {
		role: CLAUDE_SPAN_TYPE_ROLES[attributes["span.type"] ?? ""] ?? "other",
		operation: str(attributes, "span.type"),
		sessionKey: str(attributes, "session.id"),
	}
	const model = str(attributes, "model")
	if (model !== null) facts.model = model
	const inputTokens = num(attributes, "input_tokens")
	if (inputTokens !== null) {
		facts.inputTokens = inputTokens
		facts.outputTokens = num(attributes, "output_tokens")
		facts.cacheReadTokens = num(attributes, "cache_read_tokens")
		facts.cacheCreationTokens = num(attributes, "cache_creation_tokens")
	}
	// The CLI exports no message content; the turn root's `user_prompt` (behind
	// OTEL_LOG_USER_PROMPTS) is the only conversational text in the dialect.
	const userPrompt = str(attributes, "user_prompt")
	if (userPrompt !== null) facts.inputText = userPrompt
	return facts
}

// vercel_ai_sdk — one vendor, two mutually exclusive wire dialects. The GenAI
// dialect is semconv and the base handles it (plus `agent_step`, an
// SDK-invented operation name). The legacy dialect spells everything under
// `ai.*` (`ai.usage.inputTokens`, `ai.model.id`, `ai.operationId`) and its
// umbrella spans (`ai.generateText`) carry ONLY the `ai.*` spellings. The
// session key is the eve-hosted case: the framework splices its session id
// into the runtime context as `ai.settings.context.eve.session.id`; a plain
// AI SDK span has no session-key convention at all.
const vercelAiSdkIntegration: AiVendorIntegration = ({ attributes }) => {
	const facts: AiSpanFactOverrides = {}
	const operationId = attributes["ai.operationId"]
	if (operationId === "ai.toolCall") facts.role = "tool"
	else if (operationId !== undefined) {
		// Legacy dialect: the `.doGenerate`/`.doStream`/`.doEmbed` leaf is the model
		// call; the umbrella (`ai.generateText`, …) REPEATS its leaves' aggregated
		// usage, so it must stay out of the llm tier or session totals double-count.
		facts.role = /\.do[A-Z]/.test(operationId) ? "llm" : "agent"
	} else if (attributes["gen_ai.operation.name"] === "agent_step") facts.role = "agent"
	// The legacy dialect's operation name; the GenAI dialect carries the semconv
	// one the base already read.
	if (operationId !== undefined && operationId !== "") facts.operation = operationId
	const model = str(attributes, "ai.model.id")
	const baseHasModel =
		attributes["gen_ai.response.model"] !== undefined ||
		attributes["gen_ai.request.model"] !== undefined
	if (model !== null && !baseHasModel) facts.model = model
	const inputTokens = num(attributes, "ai.usage.inputTokens")
	if (inputTokens !== null && attributes["gen_ai.usage.input_tokens"] === undefined) {
		facts.inputTokens = inputTokens
		facts.outputTokens = num(attributes, "ai.usage.outputTokens")
		facts.cacheReadTokens = num(attributes, "ai.usage.cachedInputTokens")
	}
	const sessionKey = str(attributes, "ai.settings.context.eve.session.id")
	if (sessionKey !== null) facts.sessionKey = sessionKey
	// Legacy-dialect content spellings; the GenAI dialect uses the semconv
	// message keys the base reads.
	const input =
		str(attributes, "ai.prompt.messages") ??
		str(attributes, "ai.prompt") ??
		str(attributes, "ai.toolCall.args")
	if (input !== null && facts.inputText === undefined && attributes["gen_ai.input.messages"] === undefined)
		facts.inputText = input
	const output = str(attributes, "ai.response.text") ?? str(attributes, "ai.toolCall.result")
	if (output !== null && attributes["gen_ai.output.messages"] === undefined)
		facts.outputText = output
	return facts
}

// eve — claims exactly one span shape: the `ai.eve.turn` turn root (scope
// `eve`). The bare `eve.*` keys exist only there; the turn's model/tool spans
// are vercel_ai_sdk's. A turn root is the agent tier and carries no tokens.
const eveIntegration: AiVendorIntegration = ({ attributes }) => ({
	role: "agent",
	sessionKey: str(attributes, "eve.session.id"),
})

// Only vendors whose wire format diverges from semconv in a way we have
// verified against captured data get an entry. Absence means "the base is
// right", not "unsupported".
const INTEGRATIONS: Readonly<Record<string, AiVendorIntegration>> = {
	mastra: mastraIntegration,
	claude_agent_sdk: claudeAgentSdkIntegration,
	vercel_ai_sdk: vercelAiSdkIntegration,
	eve: eveIntegration,
}

/** Base semconv facts merged with the vendor's overrides — the one entry point.
 *  A field the integration returns as `undefined` keeps the base's answer. */
export const normalizeAiSpan = (span: AiSpanInput): AiSpanFacts => {
	const facts = baseNormalize(span)
	const integration = INTEGRATIONS[span.vendor]
	if (integration === undefined) return facts
	const overrides = integration(span)
	const merged: Record<string, unknown> = { ...facts }
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) merged[key] = value
	}
	return merged as unknown as AiSpanFacts
}
