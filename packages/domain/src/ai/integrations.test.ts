import { describe, expect, it } from "vitest"
import { normalizeAiSpan } from "./integrations"

// Attribute fixtures are lifted from the trace-capture corpus (the same
// captures the Rust classifier's rules were derived from), trimmed to the keys
// the normalizer reads plus decoys proving it ignores payload attributes.

describe("normalizeAiSpan", () => {
	it("base: semconv chat span (unknown:genai bucket)", () => {
		const facts = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat openai/gpt-5.6-luna",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "openai/gpt-5.6-luna",
				"gen_ai.usage.input_tokens": "4927",
				"gen_ai.usage.output_tokens": "64",
				"gen_ai.usage.cache_read.input_tokens": "0",
				"gen_ai.usage.cache_creation.input_tokens": "4924",
			},
		})
		expect(facts).toEqual({
			role: "llm",
			operation: "chat",
			providerName: null,
			model: "openai/gpt-5.6-luna",
			inputTokens: 4927,
			outputTokens: 64,
			cacheReadTokens: 0,
			cacheCreationTokens: 4924,
			reasoningTokens: null,
			costUsd: null,
			sessionKey: null,
			compacted: null,
			previousResponseId: null,
			agentName: null,
			agentId: null,
			agentDescription: null,
			agentVersion: null,
			workflowName: null,
			toolName: null,
			toolCallId: null,
			toolType: null,
			toolDescription: null,
			toolDefinitions: null,
			responseId: null,
			finishReasons: null,
			responseStatus: null,
			timeToFirstChunk: null,
			errorType: null,
			systemInstructions: null,
			promptName: null,
			promptVersion: null,
			promptVariables: null,
			inputText: null,
			outputText: null,
		})
	})

	it("base: identity, agent/workflow/tool names and response metadata", () => {
		const tool = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "execute_tool get_weather",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.provider.name": "anthropic",
				"gen_ai.agent.name": "Math Tutor",
				"gen_ai.agent.id": "asst_01H9",
				"gen_ai.workflow.name": "research_crew",
				"gen_ai.tool.name": "get_weather",
				"gen_ai.tool.call.id": "call_9f2c",
				"gen_ai.tool.type": "function",
			},
		})
		expect(tool.role).toBe("tool")
		expect(tool.operation).toBe("execute_tool")
		expect(tool.providerName).toBe("anthropic")
		expect(tool.agentName).toBe("Math Tutor")
		expect(tool.agentId).toBe("asst_01H9")
		expect(tool.workflowName).toBe("research_crew")
		expect(tool.toolName).toBe("get_weather")
		expect(tool.toolCallId).toBe("call_9f2c")
		expect(tool.toolType).toBe("function")

		const chat = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.response.id": "chatcmpl-123",
				"gen_ai.usage.output_tokens": "512",
				// A subset of output_tokens — surfaced, never summed into a total.
				"gen_ai.usage.reasoning.output_tokens": "448",
			},
		})
		expect(chat.responseId).toBe("chatcmpl-123")
		expect(chat.outputTokens).toBe(512)
		expect(chat.reasoningTokens).toBe(448)
	})

	it("base: newer standard operations get their tier, the rest stay honest", () => {
		const workflow = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "invoke_workflow research",
			attributes: { "gen_ai.operation.name": "invoke_workflow" },
		})
		expect(workflow.role).toBe("workflow")

		const plan = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "plan Math Tutor",
			attributes: { "gen_ai.operation.name": "plan" },
		})
		expect(plan.role).toBe("agent")

		// Retrieval and the memory family have no tier of ours; `operation` is
		// what keeps them identifiable.
		const retrieval = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "retrieval docs",
			attributes: { "gen_ai.operation.name": "retrieval" },
		})
		expect(retrieval.role).toBe("other")
		expect(retrieval.operation).toBe("retrieval")
	})

	it("base: finish reasons survive either wire encoding", () => {
		const attrs = (value: string) => ({
			vendor: "unknown:genai",
			spanName: "chat",
			attributes: { "gen_ai.operation.name": "chat", "gen_ai.response.finish_reasons": value },
		})
		// The collector's JSON encoding of a string[] attribute.
		expect(normalizeAiSpan(attrs('["stop","length"]')).finishReasons).toEqual(["stop", "length"])
		// Exporters that flatten a single-element list to the bare value.
		expect(normalizeAiSpan(attrs("stop")).finishReasons).toEqual(["stop"])
		// Neither JSON nor a list of strings: keep the raw value rather than drop it.
		expect(normalizeAiSpan(attrs('["stop"')).finishReasons).toEqual(['["stop"'])
		expect(normalizeAiSpan(attrs("[1,2]")).finishReasons).toEqual(["[1,2]"])
		expect(normalizeAiSpan(attrs("")).finishReasons).toBeNull()
		expect(
			normalizeAiSpan({ vendor: "unknown:genai", spanName: "chat", attributes: {} })
				.finishReasons,
		).toBeNull()
	})

	it("base: lifecycle, error, streaming and prompt-template facts", () => {
		const facts = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.previous_response.id": "resp_01H9",
				"gen_ai.response.status": "in_progress",
				"gen_ai.response.time_to_first_chunk": "0.482",
				// The borrowed Stable attribute, outside the gen_ai.* family.
				"error.type": "rate_limit_exceeded",
				"gen_ai.agent.description": "Answers algebra questions",
				"gen_ai.agent.version": "3.1.0",
				"gen_ai.tool.description": "Looks up the current forecast",
				"gen_ai.tool.definitions": '[{"type":"function","name":"get_weather"}]',
				"gen_ai.system_instructions": "You are a helpful assistant.",
				"gen_ai.prompt.name": "weather_briefing",
				"gen_ai.prompt.version": "7",
			},
		})
		expect(facts.previousResponseId).toBe("resp_01H9")
		expect(facts.responseStatus).toBe("in_progress")
		expect(facts.timeToFirstChunk).toBe(0.482)
		expect(facts.errorType).toBe("rate_limit_exceeded")
		expect(facts.agentDescription).toBe("Answers algebra questions")
		expect(facts.agentVersion).toBe("3.1.0")
		expect(facts.toolDescription).toBe("Looks up the current forecast")
		// Raw JSON on purpose — rendering the tool list is a UI concern.
		expect(facts.toolDefinitions).toBe('[{"type":"function","name":"get_weather"}]')
		expect(facts.systemInstructions).toBe("You are a helpful assistant.")
		expect(facts.promptName).toBe("weather_briefing")
		expect(facts.promptVersion).toBe("7")
	})

	it("base: compaction is a string boolean on the wire", () => {
		const compacted = (attributes: Record<string, string>) =>
			normalizeAiSpan({ vendor: "unknown:genai", spanName: "chat", attributes }).compacted
		expect(compacted({ "gen_ai.conversation.compacted": "true" })).toBe(true)
		// Spec says instrumentations never emit false, but wire data is not a promise.
		expect(compacted({ "gen_ai.conversation.compacted": "false" })).toBe(false)
		// Anything else is not a boolean the exporter meant — absent, not falsey.
		expect(compacted({ "gen_ai.conversation.compacted": "TRUE" })).toBeNull()
		expect(compacted({ "gen_ai.conversation.compacted": "1" })).toBeNull()
		expect(compacted({ "gen_ai.conversation.compacted": "" })).toBeNull()
		expect(compacted({})).toBeNull()
	})

	it("base: prompt variables are collected off the key prefix", () => {
		const facts = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.prompt.name": "weather_briefing",
				"gen_ai.prompt.variable.city": "Amsterdam",
				"gen_ai.prompt.variable.tone": "terse",
				// Neighbours under the prompt namespace are not variables.
				"gen_ai.prompt.version": "7",
			},
		})
		expect(facts.promptVariables).toEqual({ city: "Amsterdam", tone: "terse" })

		const none = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat",
			attributes: { "gen_ai.operation.name": "chat" },
		})
		expect(none.promptVariables).toBeNull()
	})

	it("base: response model wins over request model", () => {
		const facts = normalizeAiSpan({
			vendor: "unknown:genai",
			spanName: "chat",
			attributes: {
				"gen_ai.request.model": "gpt-4o",
				"gen_ai.response.model": "gpt-4o-2024-08-06",
			},
		})
		expect(facts.model).toBe("gpt-4o-2024-08-06")
	})

	it("base: a vendor without an integration falls through untouched", () => {
		// A crewai orchestration span: no gen_ai.* payload at all — every fact
		// honestly unknown, tokens come from its openinference-openai children.
		const facts = normalizeAiSpan({
			vendor: "crewai",
			spanName: "research_crew.kickoff",
			attributes: { crew_key: "8b6f4a", "session.id": "run-oi-17" },
		})
		expect(facts.role).toBe("other")
		expect(facts.inputTokens).toBeNull()
		// `session.id` is crewai's keyed attribute, but without an integration the
		// base must not guess a display key from a non-semconv spelling.
		expect(facts.sessionKey).toBeNull()
	})

	it("mastra: span-type roles override, semconv tokens stay", () => {
		const inference = normalizeAiSpan({
			vendor: "mastra",
			spanName: "model_inference weather_worker",
			attributes: {
				"mastra.span.type": "model_inference",
				"gen_ai.operation.name": "model_inference",
				"mastra.metadata.runId": "cc714c79-e4c9-4877-baf4-0b3789761ed9",
			},
		})
		expect(inference.role).toBe("llm")

		const step = normalizeAiSpan({
			vendor: "mastra",
			spanName: "workflow_step amsterdam_briefing",
			attributes: { "mastra.span.type": "workflow_step" },
		})
		expect(step.role).toBe("workflow")

		// The token-bearing `chat` span is pure semconv — base answers everything,
		// including the session display key from `gen_ai.conversation.id`.
		const chat = normalizeAiSpan({
			vendor: "mastra",
			spanName: "chat openai/gpt-4o-mini",
			attributes: {
				"mastra.span.type": "model_generation",
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "openai/gpt-4o-mini",
				"gen_ai.response.model": "openai/gpt-4o-mini",
				"gen_ai.usage.input_tokens": "89",
				"gen_ai.usage.output_tokens": "88",
				"gen_ai.conversation.id": "support-thread-42",
			},
		})
		expect(chat.role).toBe("llm")
		expect(chat.inputTokens).toBe(89)
		expect(chat.sessionKey).toBe("support-thread-42")
	})

	it("claude_agent_sdk: bare-key dialect", () => {
		const llm = normalizeAiSpan({
			vendor: "claude_agent_sdk",
			spanName: "claude_code.llm_request",
			attributes: {
				"span.type": "llm_request",
				model: "anthropic/claude-haiku-4.5",
				input_tokens: "3550",
				output_tokens: "408",
				cache_read_tokens: "4248",
				cache_creation_tokens: "2025",
				"session.id": "f0f992b0-c9f7-4d8c-8c93-beaea0904dda",
				"gen_ai.system": "anthropic",
			},
		})
		expect(llm).toEqual({
			role: "llm",
			operation: "llm_request",
			providerName: null,
			model: "anthropic/claude-haiku-4.5",
			inputTokens: 3550,
			outputTokens: 408,
			cacheReadTokens: 4248,
			cacheCreationTokens: 2025,
			reasoningTokens: null,
			costUsd: null,
			sessionKey: "f0f992b0-c9f7-4d8c-8c93-beaea0904dda",
			compacted: null,
			previousResponseId: null,
			agentName: null,
			agentId: null,
			agentDescription: null,
			agentVersion: null,
			workflowName: null,
			toolName: null,
			toolCallId: null,
			toolType: null,
			toolDescription: null,
			toolDefinitions: null,
			responseId: null,
			finishReasons: null,
			responseStatus: null,
			timeToFirstChunk: null,
			errorType: null,
			systemInstructions: null,
			promptName: null,
			promptVersion: null,
			promptVariables: null,
			inputText: null,
			outputText: null,
		})

		const gate = normalizeAiSpan({
			vendor: "claude_agent_sdk",
			spanName: "claude_code.tool.blocked_on_user",
			attributes: {
				"span.type": "tool.blocked_on_user",
				"session.id": "f0f992b0-c9f7-4d8c-8c93-beaea0904dda",
			},
		})
		expect(gate.role).toBe("tool")
		expect(gate.inputTokens).toBeNull()

		const turn = normalizeAiSpan({
			vendor: "claude_agent_sdk",
			spanName: "claude_code.interaction",
			attributes: { "span.type": "interaction", "session.id": "s" },
		})
		expect(turn.role).toBe("agent")
	})

	it("vercel_ai_sdk: GenAI dialect is base + agent_step", () => {
		const step = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "step 1",
			attributes: {
				"gen_ai.operation.name": "agent_step",
				"ai.settings.context.eve.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
			},
		})
		expect(step.role).toBe("agent")
		expect(step.sessionKey).toBe("wrun_01KZAAFFZRHHRYC8MY9MDANASQ")

		const chat = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "chat openai/gpt-4o-mini",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "openai/gpt-4o-mini",
				"gen_ai.usage.input_tokens": "258",
				"gen_ai.usage.output_tokens": "83",
				// Detail spellings ride along in the GenAI dialect — must not shadow.
				"ai.usage.inputTokenDetails.noCacheTokens": "258",
			},
		})
		expect(chat.role).toBe("llm")
		expect(chat.inputTokens).toBe(258)
		expect(chat.model).toBe("openai/gpt-4o-mini")
	})

	it("vercel_ai_sdk: legacy dialect spells everything under ai.*", () => {
		// An umbrella span: ONLY `ai.*` spellings — the base finds nothing. Its
		// usage repeats the child doGenerate aggregates, so the role is the agent
		// tier (llm-tier totals would double-count it).
		const umbrella = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "ai.generateText",
			attributes: {
				"ai.operationId": "ai.generateText",
				"ai.model.id": "openai/gpt-4o-mini",
				"ai.usage.inputTokens": "209",
				"ai.usage.outputTokens": "44",
				"ai.usage.cachedInputTokens": "0",
			},
		})
		expect(umbrella).toEqual({
			role: "agent",
			operation: "ai.generateText",
			providerName: null,
			model: "openai/gpt-4o-mini",
			inputTokens: 209,
			outputTokens: 44,
			cacheReadTokens: 0,
			cacheCreationTokens: null,
			reasoningTokens: null,
			costUsd: null,
			sessionKey: null,
			compacted: null,
			previousResponseId: null,
			agentName: null,
			agentId: null,
			agentDescription: null,
			agentVersion: null,
			workflowName: null,
			toolName: null,
			toolCallId: null,
			toolType: null,
			toolDescription: null,
			toolDefinitions: null,
			responseId: null,
			finishReasons: null,
			responseStatus: null,
			timeToFirstChunk: null,
			errorType: null,
			systemInstructions: null,
			promptName: null,
			promptVersion: null,
			promptVariables: null,
			inputText: null,
			outputText: null,
		})

		// A doGenerate span carries BOTH spellings; the semconv one must win so
		// the two dialects can never double-report.
		const doGenerate = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "ai.generateText.doGenerate",
			attributes: {
				"ai.operationId": "ai.generateText.doGenerate",
				"ai.model.id": "openai/gpt-4o-mini",
				"ai.usage.inputTokens": "209",
				"gen_ai.usage.input_tokens": "209",
				"gen_ai.usage.output_tokens": "44",
				"gen_ai.request.model": "openai/gpt-4o-mini",
			},
		})
		expect(doGenerate.role).toBe("llm")
		expect(doGenerate.inputTokens).toBe(209)
		expect(doGenerate.outputTokens).toBe(44)

		const toolCall = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "ai.toolCall",
			attributes: { "ai.operationId": "ai.toolCall" },
		})
		expect(toolCall.role).toBe("tool")
	})

	it("content: each vendor's conversational spellings resolve to input/output", () => {
		// Semconv messages (GenAI dialect / mastra chat spans) — base.
		const semconv = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "chat openai/gpt-4o-mini",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
				"gen_ai.output.messages":
					'[{"role":"assistant","parts":[{"type":"text","content":"hello"}]}]',
			},
		})
		expect(semconv.inputText).toContain('"hi"')
		expect(semconv.outputText).toContain('"hello"')

		// Semconv tool call/result — base.
		const tool = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "execute_tool get_weather",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.call.arguments": '{"city":"Amsterdam"}',
				"gen_ai.tool.call.result": '{"temperature_c":21}',
			},
		})
		expect(tool.inputText).toBe('{"city":"Amsterdam"}')
		expect(tool.outputText).toBe('{"temperature_c":21}')

		// Legacy AI SDK spellings.
		const legacy = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "ai.generateText",
			attributes: {
				"ai.operationId": "ai.generateText",
				"ai.prompt.messages": '[{"role":"user","content":"hi"}]',
				"ai.response.text": "hello there",
			},
		})
		expect(legacy.inputText).toBe('[{"role":"user","content":"hi"}]')
		expect(legacy.outputText).toBe("hello there")

		// Mastra's per-span-type keys.
		const mastra = normalizeAiSpan({
			vendor: "mastra",
			spanName: "agent_run orchestrator",
			attributes: {
				"mastra.span.type": "agent_run",
				"mastra.agent_run.input": "Produce a briefing",
				"mastra.agent_run.output": '{"text":"**Target City: Amsterdam**"}',
			},
		})
		expect(mastra.inputText).toBe("Produce a briefing")
		expect(mastra.outputText).toBe('{"text":"**Target City: Amsterdam**"}')

		// Claude's turn-root user_prompt.
		const claude = normalizeAiSpan({
			vendor: "claude_agent_sdk",
			spanName: "claude_code.interaction",
			attributes: { "span.type": "interaction", user_prompt: "Produce a briefing" },
		})
		expect(claude.inputText).toBe("Produce a briefing")
	})

	it("operation: every vendor's own span-type spelling reaches the fact", () => {
		// Mastra's span type, which is also what its `gen_ai.operation.name` says.
		const mastra = normalizeAiSpan({
			vendor: "mastra",
			spanName: "workflow_step amsterdam_briefing",
			attributes: { "mastra.span.type": "workflow_step" },
		})
		expect(mastra.operation).toBe("workflow_step")

		const claude = normalizeAiSpan({
			vendor: "claude_agent_sdk",
			spanName: "claude_code.tool.execution",
			attributes: { "span.type": "tool.execution", "session.id": "s" },
		})
		expect(claude.operation).toBe("tool.execution")

		// Legacy AI SDK dialect: `ai.operationId` is the operation name.
		const legacy = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "ai.generateText.doGenerate",
			attributes: { "ai.operationId": "ai.generateText.doGenerate" },
		})
		expect(legacy.operation).toBe("ai.generateText.doGenerate")

		// GenAI dialect: no `ai.operationId`, so the base's semconv reading stands.
		const genai = normalizeAiSpan({
			vendor: "vercel_ai_sdk",
			spanName: "chat openai/gpt-4o-mini",
			attributes: { "gen_ai.operation.name": "chat" },
		})
		expect(genai.operation).toBe("chat")

		// eve's turn root has no operation key at all — null, not a guess.
		const eve = normalizeAiSpan({
			vendor: "eve",
			spanName: "ai.eve.turn",
			attributes: { "eve.session.id": "wrun_01KZ" },
		})
		expect(eve.operation).toBeNull()
	})

	it("eve: the turn root is the agent tier and carries the session key", () => {
		const turn = normalizeAiSpan({
			vendor: "eve",
			spanName: "ai.eve.turn",
			attributes: {
				"eve.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
				"eve.turn.id": "turn_1",
				"ai.telemetry.functionId": "slack-agent",
			},
		})
		expect(turn.role).toBe("agent")
		expect(turn.sessionKey).toBe("wrun_01KZAAFFZRHHRYC8MY9MDANASQ")
		expect(turn.inputTokens).toBeNull()
	})
})
