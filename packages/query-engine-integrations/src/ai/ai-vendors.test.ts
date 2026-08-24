import { describe, expect, it } from "vitest"
import { mapAiSpan, resolveAiIntegration } from "./ai-integrations"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"
import type { AiSessionSpansOutput } from "./ai-sessions"

const row = (vendorId: string, spanAttributes: Record<string, string>): AiSessionSpansOutput => ({
	traceId: "a1e33a5cc671a33952cc0e1117701290",
	spanId: "a2d0b69ed027b25b",
	parentSpanId: "2bafd07bbfb0eeb3",
	spanName: "ai.eve.turn",
	spanKind: "Internal",
	serviceName: "maple-slack-agent",
	durationMs: 3632.565327,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-12 15:19:41.626000000",
	spanAttributes: { ...spanAttributes, "maple_ai.vendor.id": vendorId, "maple_ai.vendor.version": "0" },
	resourceAttributes: {},
})

describe("vercel_ai_sdk", () => {
	it("reads the older ai.* usage keys the default integration knows nothing about", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"ai.usage.promptTokens": "5033",
				"ai.usage.completionTokens": "38",
				"ai.model.id": "openai/gpt-5.6-luna",
				"ai.model.provider": "openrouter",
				"ai.response.finishReason": "stop",
			}),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
		expect(mapped.genAi.usageOutputTokens).toBe(38)
		expect(mapped.genAi.requestModel).toBe("openai/gpt-5.6-luna")
		expect(mapped.genAi.providerName).toBe("openrouter")
		expect(mapped.genAi.responseFinishReasons).toEqual(["stop"])
		expect(resolveAiIntegration("vercel_ai_sdk").id).toBe("vercel_ai_sdk")
	})

	it("keeps the canonical gen_ai key winning over the ai.* alias", () => {
		// Current AI SDK versions emit both dialects on the same span; the
		// convention's key has to be the one that lands.
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", { "gen_ai.usage.input_tokens": "5033", "ai.usage.promptTokens": "1" }),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
	})

	it("maps the tool dialect of an older SDK span", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"ai.toolCall.name": "add_reaction",
				"ai.toolCall.id": "call_uKgzomwVJhP3bYZ0fxvwUe86",
				"ai.toolCall.args": '{"emoji":"wave"}',
				"ai.toolCall.result": '{"reacted":true}',
			}),
		)

		expect(mapped.genAi.toolName).toBe("add_reaction")
		expect(mapped.genAi.toolCallId).toBe("call_uKgzomwVJhP3bYZ0fxvwUe86")
		expect(mapped.genAi.toolCallArguments).toEqual({ emoji: "wave" })
		expect(mapped.genAi.toolCallResult).toEqual({ reacted: true })
	})

	it("falls back to the telemetry function id for the agent name", () => {
		// Real spans in this org put the same value in both, and it is the only
		// agent identity an older-SDK span carries.
		expect(
			mapAiSpan(row("vercel_ai_sdk", { "ai.telemetry.functionId": "slack-agent" })).genAi.agentName,
		).toBe("slack-agent")
		expect(
			mapAiSpan(
				row("vercel_ai_sdk", {
					"gen_ai.agent.name": "triage",
					"ai.telemetry.functionId": "slack-agent",
				}),
			).genAi.agentName,
		).toBe("triage")
	})

	it("leaves fields it does not mention on the default source list", () => {
		// The merge is per field: `requestSeed` is not in the override, so it
		// keeps the default's canonical key AND the default's legacy alias.
		const mapped = mapAiSpan(row("vercel_ai_sdk", { "gen_ai.openai.request.seed": "7" }))

		expect(mapped.genAi.requestSeed).toBe(7)
	})

	it("still runs the default refine for a vendor span", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"gen_ai.system": "vertex_ai",
				"gen_ai.response.finish_reasons": '["tool_calls"]',
			}),
		)

		expect(mapped.genAi.providerName).toBe("gcp.vertex_ai")
		expect(mapped.genAi.responseFinishReasons).toEqual(["tool_call"])
	})
})

describe("openinference", () => {
	it("is registered under both vendor ids the gateway can stamp", () => {
		// Same dialect, two detection paths: the OpenAI instrumentor by name, and
		// the generic bucket for any other `openinference.instrumentation.*` scope.
		expect(AI_VENDOR_INTEGRATIONS["openinference-openai"]).toBe(
			AI_VENDOR_INTEGRATIONS["unknown:openinference"],
		)
		expect(resolveAiIntegration("unknown:openinference").id).toBe("openinference")
		expect(resolveAiIntegration("openinference-openai").id).toBe("openinference")
	})

	it("maps the llm.* dialect", () => {
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"llm.model_name": "gpt-5",
				"llm.provider": "openai",
				"llm.token_count.prompt": "5033",
				"llm.token_count.completion": "38",
				"llm.token_count.prompt_details.cache_read": "4924",
				"llm.token_count.completion_details.reasoning": "12",
				"input.value": '{"messages":[{"role":"user"}]}',
				"output.value": '{"messages":[{"role":"assistant"}]}',
				"tool.name": "search",
				"tool.description": "search the docs",
			}),
		)

		expect(mapped.genAi).toMatchObject({
			requestModel: "gpt-5",
			providerName: "openai",
			usageInputTokens: 5033,
			usageOutputTokens: 38,
			usageCacheReadInputTokens: 4924,
			usageReasoningOutputTokens: 12,
			inputMessages: { messages: [{ role: "user" }] },
			outputMessages: { messages: [{ role: "assistant" }] },
			toolName: "search",
			toolDescription: "search the docs",
		})
	})

	it("appends its dialect keys to the default's list rather than replacing it", () => {
		// The dialect key is read when it is the only one present, and the
		// canonical key still wins when the span carries both.
		const dialect = mapAiSpan(
			row("openinference-openai", { "llm.output_messages": '[{"role":"assistant","from":"dialect"}]' }),
		)

		expect(dialect.genAi.outputMessages).toEqual([{ role: "assistant", from: "dialect" }])

		const both = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.output.messages": '[{"role":"assistant","from":"canonical"}]',
				"llm.output_messages": '[{"role":"assistant","from":"dialect"}]',
			}),
		)

		expect(both.genAi.outputMessages).toEqual([{ role: "assistant", from: "canonical" }])
	})

	it("still reads the default's legacy aliases it did not supersede", () => {
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.usage.prompt_tokens": "120",
				"gen_ai.completion": '[{"role":"assistant"}]',
			}),
		)

		expect(mapped.genAi.usageInputTokens).toBe(120)
		expect(mapped.genAi.outputMessages).toEqual([{ role: "assistant" }])
	})

	it("translates the span kind into a gen_ai operation name", () => {
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "LLM" })).genAi.operationName,
		).toBe("chat")
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "TOOL" })).genAi.operationName,
		).toBe("execute_tool")
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "AGENT" })).genAi
				.operationName,
		).toBe("invoke_agent")
	})

	it("leaves a span kind with no convention equivalent unmapped", () => {
		// Better an absent `operationName` than one carrying a value no GenAI
		// filter in the product can match.
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "CHAIN" })).genAi
				.operationName,
		).toBeUndefined()
	})

	it("runs after the default refine, so it sees the mapped operation name", () => {
		// Hook order is default-then-vendor: the vendor's translation defers to a
		// real `gen_ai.operation.name` that the default mapping already produced.
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.operation.name": "chat",
				"openinference.span.kind": "TOOL",
			}),
		)

		expect(mapped.genAi.operationName).toBe("chat")
	})
})

describe("eve", () => {
	it("maps a real ai.eve.turn span, which is a session envelope and nothing else", () => {
		// eve's own span carries no generation attributes at all — the model call
		// happens on Vercel-AI-SDK child spans the gateway stamps separately.
		const mapped = mapAiSpan(
			row("eve", {
				"ai.telemetry.functionId": "slack-agent",
				"eve.environment": "production",
				"eve.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
				"eve.turn.id": "turn_1",
				"eve.version": "0.25.3",
				"maple_ai.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
			}),
		)

		expect(mapped.genAi).toEqual({ conversationId: "turn_1" })
		expect(mapped.sessionId).toBe("wrun_01KZAAFFZRHHRYC8MY9MDANASQ")
		expect(resolveAiIntegration("eve").id).toBe("eve")
		expect(mapped.isAiSpan).toBe(true)
	})

	it("does not overwrite a conversation id the span already declared", () => {
		const mapped = mapAiSpan(row("eve", { "gen_ai.conversation.id": "conv-1", "eve.turn.id": "turn_1" }))

		expect(mapped.genAi.conversationId).toBe("conv-1")
	})

	it("runs both refine hooks, default first", () => {
		// Two observable effects on one span: the default's provider rename and
		// the vendor's turn-id mapping.
		const mapped = mapAiSpan(row("eve", { "gen_ai.system": "xai", "eve.turn.id": "turn_1" }))

		expect(mapped.genAi.providerName).toBe("x_ai")
		expect(mapped.genAi.conversationId).toBe("turn_1")
	})
})

describe("maple", () => {
	it("maps a self-instrumented chat span: canonical gen_ai plus the lifted turn id", () => {
		// What `apps/api`'s chat loop actually emits — canonical `gen_ai.*` the
		// default integration decodes, with only the turn id needing the vendor.
		const mapped = mapAiSpan(
			row("maple", {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "openai/gpt-5.6-luna",
				"gen_ai.provider.name": "openrouter",
				"gen_ai.usage.input_tokens": "15400",
				"maple.session.id": "org_1:inv-abc",
				"maple.turn.id": "msg_1",
				"maple_ai.session.id": "org_1:inv-abc",
			}),
		)

		expect(mapped.genAi.conversationId).toBe("msg_1")
		expect(mapped.genAi.operationName).toBe("chat")
		expect(mapped.genAi.usageInputTokens).toBe(15400)
		expect(mapped.sessionId).toBe("org_1:inv-abc")
		expect(resolveAiIntegration("maple").id).toBe("maple")
		expect(mapped.isAiSpan).toBe(true)
	})

	it("does not overwrite a conversation id the span already declared", () => {
		const mapped = mapAiSpan(
			row("maple", { "gen_ai.conversation.id": "conv-1", "maple.turn.id": "msg_1" }),
		)

		expect(mapped.genAi.conversationId).toBe("conv-1")
	})
})

describe("the vendor merge only ever adds keys", () => {
	it("maps a legacy-only span identically under every vendor", () => {
		// A vendor's dialect keys are appended to the default's list, so an
		// override cannot cost a span a field the default would have mapped.
		// Driven from the registry so a new override inherits the check.
		const LEGACY_ONLY_SPAN = {
			"gen_ai.usage.prompt_tokens": "120",
			"gen_ai.usage.completion_tokens": "34",
			"gen_ai.usage.input_tokens.cached": "2048",
			"gen_ai.usage.output_tokens.reasoning": "704",
			"gen_ai.prompt": '[{"role":"user"}]',
			"gen_ai.completion": '[{"role":"assistant"}]',
			"gen_ai.system": "anthropic",
			"gen_ai.response.finish_reason": "stop",
			"gen_ai.usage.cost": "0.0042",
		}
		// An unregistered stamp resolves to the default integration, which is the
		// baseline every override has to reproduce.
		const baseline = mapAiSpan(row("unknown:other", LEGACY_ONLY_SPAN)).genAi

		for (const vendorId of Object.keys(AI_VENDOR_INTEGRATIONS)) {
			expect(mapAiSpan(row(vendorId, LEGACY_ONLY_SPAN)).genAi).toEqual(baseline)
		}
	})
})
