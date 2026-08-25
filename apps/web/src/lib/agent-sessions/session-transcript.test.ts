import { describe, expect, it } from "vitest"

import type { AiSessionSpan } from "@maple/domain/http"

import { buildSessionTurns } from "./session-turns"
import { buildTranscript, payload, type TranscriptInput, type TranscriptRow } from "./session-transcript"
import { sessionToolResults } from "./span-detail"
import { agentSpan, llmSpan, toolSpan } from "./span-test-support"

const SECOND = 1000

function transcript(spans: readonly AiSessionSpan[], overrides: Partial<TranscriptInput> = {}) {
	return buildTranscript({
		turns: buildSessionTurns(spans),
		toolResults: sessionToolResults(spans),
		query: "",
		showThinking: true,
		truncated: false,
		collapsedTurns: new Set(),
		...overrides,
	})
}

const kinds = (rows: readonly TranscriptRow[]) => rows.map((row) => row.kind)

/** One agent-rooted turn: an agent span plus whatever ran under it. */
function turnSpans(input: {
	readonly agentId?: string
	readonly agentName?: string
	readonly traceId?: string
	readonly startMs: number
	readonly durationMs: number
	readonly children: readonly AiSessionSpan[]
}): readonly AiSessionSpan[] {
	return [
		agentSpan({
			spanId: input.agentId ?? "agent",
			traceId: input.traceId ?? "trace-1",
			startMs: input.startMs,
			durationMs: input.durationMs,
			agentName: input.agentName ?? "planner-agent",
		}),
		...input.children,
	]
}

describe("buildTranscript — turn shape", () => {
	it("absorbs the turn's anchor span into its header and orders the rest by parentage", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 20 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: 2 * SECOND,
					model: "claude-opus-5",
					genAi: {
						systemInstructions: "you are the investigation planner",
						inputMessages: [
							{ role: "user", parts: [{ type: "text", content: "p95 tripled — find what changed" }] },
						],
						outputMessages: [
							{ role: "assistant", parts: [{ type: "text", content: "reading the traces first" }] },
						],
					},
				}),
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: { toolCallId: "toolu_1", toolCallArguments: { sql: "SELECT 1" }, toolCallResult: "1" },
				}),
			],
		})

		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "system", "user", "assistant", "tool"])
		// No row for the agent span itself: the chapter header is that row.
		expect(rows.every((row) => !("span" in row) || row.span.spanId !== "agent")).toBe(true)
	})

	// A conversation-id partition can anchor a turn on the model call that opened
	// it, and that call's reply IS the turn — only an agent anchor is redundant.
	it("keeps a model-call anchor's own reply", () => {
		const spans = [
			llmSpan({
				spanId: "l1",
				startMs: 0,
				durationMs: SECOND,
				genAi: {
					conversationId: "turn-1",
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "first" }] }],
				},
			}),
			llmSpan({
				spanId: "l2",
				traceId: "trace-2",
				startMs: 10 * SECOND,
				durationMs: SECOND,
				genAi: {
					conversationId: "turn-2",
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "second" }] }],
				},
			}),
		]

		const texts = transcript(spans)
			.filter((row) => row.kind === "assistant")
			.map((row) => row.text)
		expect(texts).toEqual(["first", "second"])
	})

	it("re-derives order from parentage rather than from the turn's time slice", () => {
		// Two branches interleaved in time. Read by timestamp this is a1, b1, a2,
		// b2; each branch has to stay whole.
		const spans = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND, agentName: "planner-agent" }),
			agentSpan({
				spanId: "lane-a",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 20 * SECOND,
				agentName: "db-lane",
			}),
			agentSpan({
				spanId: "lane-b",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: 20 * SECOND,
				agentName: "trace-lane",
			}),
			toolSpan({ spanId: "a1", parentSpanId: "lane-a", startMs: 3 * SECOND, durationMs: 500, toolName: "run_sql" }),
			toolSpan({
				spanId: "b1",
				parentSpanId: "lane-b",
				startMs: 4 * SECOND,
				durationMs: 500,
				toolName: "inspect_trace",
			}),
			toolSpan({ spanId: "a2", parentSpanId: "lane-a", startMs: 5 * SECOND, durationMs: 500, toolName: "run_sql" }),
			toolSpan({
				spanId: "b2",
				parentSpanId: "lane-b",
				startMs: 6 * SECOND,
				durationMs: 500,
				toolName: "inspect_trace",
			}),
		]

		const rows = transcript(spans)
		const toolIds = rows.filter((row) => row.kind === "tool").map((row) => row.span.spanId)
		expect(toolIds).toEqual(["a1", "a2", "b1", "b2"])
	})
})

describe("buildTranscript — lanes and parallel markers", () => {
	const twoLanes = [
		agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND, agentName: "planner-agent" }),
		agentSpan({
			spanId: "lane-a",
			parentSpanId: "agent",
			traceId: "trace-a",
			startMs: SECOND,
			durationMs: 20 * SECOND,
			agentName: "db-lane",
		}),
		agentSpan({
			spanId: "lane-b",
			parentSpanId: "agent",
			traceId: "trace-b",
			startMs: 2 * SECOND,
			durationMs: 20 * SECOND,
			agentName: "trace-lane",
		}),
	]

	it("opens a lane per differently-named agent and closes it after its rows", () => {
		const rows = transcript(twoLanes)
		expect(kinds(rows)).toEqual([
			"turn",
			"parallel",
			"lane-open",
			"lane-close",
			"lane-open",
			"lane-close",
		])
	})

	it("marks overlapping lanes with reciprocal jump links", () => {
		const rows = transcript(twoLanes)
		const opens = rows.filter((row) => row.kind === "lane-open")
		expect(opens.map((row) => row.agentName)).toEqual(["db-lane", "trace-lane"])
		expect(opens[0]!.parallelWith.map((ref) => ref.agentName)).toEqual(["trace-lane"])
		expect(opens[1]!.parallelWith.map((ref) => ref.agentName)).toEqual(["db-lane"])
		// The links point at the other lane's own row key.
		expect(opens[0]!.parallelWith[0]!.key).toBe(opens[1]!.key)

		const marker = rows.find((row) => row.kind === "parallel")
		expect(marker?.kind === "parallel" && marker.forkedBy).toBe("planner-agent")
		expect(marker?.kind === "parallel" && marker.lanes).toHaveLength(2)
	})

	it("leaves sequential lanes unmarked", () => {
		const sequential = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND, agentName: "planner-agent" }),
			agentSpan({
				spanId: "lane-a",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 5 * SECOND,
				agentName: "db-lane",
			}),
			agentSpan({
				spanId: "lane-b",
				parentSpanId: "agent",
				startMs: 10 * SECOND,
				durationMs: 5 * SECOND,
				agentName: "trace-lane",
			}),
		]
		expect(kinds(transcript(sequential))).not.toContain("parallel")
	})

	// Concurrent tool calls are the normal shape of an agent loop; marking them
	// would bury the forks that matter.
	it("never marks concurrent leaf tools as parallel", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				toolSpan({ spanId: "t1", parentSpanId: "agent", startMs: 0, durationMs: 5 * SECOND, toolName: "a" }),
				toolSpan({ spanId: "t2", parentSpanId: "agent", startMs: SECOND, durationMs: 5 * SECOND, toolName: "b" }),
			],
		})
		expect(kinds(transcript(spans))).not.toContain("parallel")
	})

	// Maple emits `execute_tool task` → `invoke_agent`: one handoff, two spans.
	it("collapses the execute_tool + invoke_agent delegation pair into one subagent block", () => {
		const spans = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 30 * SECOND, agentName: "db-lane" }),
			toolSpan({
				spanId: "task",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 12 * SECOND,
				toolName: "task",
				genAi: { toolCallId: "toolu_task" },
			}),
			agentSpan({
				spanId: "sub",
				parentSpanId: "task",
				startMs: SECOND,
				durationMs: 12 * SECOND,
				agentName: "sql-verifier",
			}),
			toolSpan({
				spanId: "sub-tool",
				parentSpanId: "sub",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				toolName: "run_sql",
			}),
		]

		const rows = transcript(spans)
		// No tool card for `task`: it and the invocation are the same delegation.
		expect(kinds(rows)).toEqual(["turn", "lane-open", "tool", "lane-close"])
		const open = rows.find((row) => row.kind === "lane-open")
		expect(open?.kind === "lane-open" && open.laneKind).toBe("subagent")
		expect(open?.kind === "lane-open" && open.parentAgentName).toBe("db-lane")
		expect(rows.find((row) => row.kind === "tool")?.depth).toBe(1)
	})

	it("counts a lane's own work on its closing row", () => {
		const spans = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 30 * SECOND, agentName: "planner-agent" }),
			agentSpan({
				spanId: "lane",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: 12 * SECOND,
				agentName: "db-lane",
			}),
			llmSpan({ spanId: "l1", parentSpanId: "lane", startMs: SECOND, durationMs: SECOND, model: "m" }),
			llmSpan({ spanId: "l2", parentSpanId: "lane", startMs: 3 * SECOND, durationMs: SECOND, model: "m" }),
			toolSpan({ spanId: "t1", parentSpanId: "lane", startMs: 5 * SECOND, durationMs: SECOND, toolName: "run_sql" }),
		]

		const close = transcript(spans).find((row) => row.kind === "lane-close")
		expect(close?.kind === "lane-close" && close.llmCalls).toBe(2)
		expect(close?.kind === "lane-close" && close.toolCalls).toBe(1)
		expect(close?.kind === "lane-close" && close.durationMs).toBe(12 * SECOND)
	})
})

describe("buildTranscript — message extraction", () => {
	// `gen_ai.input.messages` is the whole history re-sent every call.
	it("takes the user message from the first captured history only, and reports the rest", () => {
		const history = [
			{ role: "user", parts: [{ type: "text", content: "turn one" }] },
			{ role: "assistant", parts: [{ type: "text", content: "answer one" }] },
			{ role: "user", parts: [{ type: "text", content: "the new question" }] },
		]
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: { inputMessages: history, outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "ok" }] }] },
				}),
				llmSpan({
					spanId: "l2",
					parentSpanId: "agent",
					startMs: 2 * SECOND,
					durationMs: SECOND,
					genAi: {
						inputMessages: [...history, { role: "user", parts: [{ type: "text", content: "re-sent" }] }],
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "done" }] }],
					},
				}),
			],
		})

		const users = transcript(spans).filter((row) => row.kind === "user")
		expect(users).toHaveLength(1)
		expect(users[0]!.text).toBe("the new question")
		expect(users[0]!.earlierCount).toBe(2)
		expect(users[0]!.history).toHaveLength(3)
	})

	it("shows one system prompt per turn and counts the calls that re-sent it", () => {
		const instructions = "you are the Maple investigation planner"
		const call = (spanId: string, startMs: number) =>
			llmSpan({
				spanId,
				parentSpanId: "agent",
				startMs,
				durationMs: SECOND,
				genAi: {
					systemInstructions: instructions,
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: spanId }] }],
				},
			})

		const rows = transcript(
			turnSpans({
				startMs: 0,
				durationMs: 10 * SECOND,
				children: [call("l1", 0), call("l2", 2 * SECOND), call("l3", 4 * SECOND)],
			}),
		)
		const systems = rows.filter((row) => row.kind === "system")
		expect(systems).toHaveLength(1)
		expect(systems[0]!.callCount).toBe(3)
	})

	it("splits reasoning out of the reply and drops it when Thinking is off", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						outputMessages: [
							{
								role: "assistant",
								parts: [
									{ type: "thinking", thinking: "both lanes point at the carts read" },
									{ type: "text", content: "the regression is the cart lookup" },
								],
							},
						],
					},
				}),
			],
		})

		expect(kinds(transcript(spans))).toEqual(["turn", "thinking", "assistant"])
		expect(kinds(transcript(spans, { showThinking: false }))).toEqual(["turn", "assistant"])
	})

	it("labels a redacted thinking block without inventing text for it", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						outputMessages: [
							{ role: "assistant", parts: [{ type: "redacted_thinking", data: "AAAA" }] },
						],
					},
				}),
			],
		})

		const thinking = transcript(spans).find((row) => row.kind === "thinking")
		expect(thinking?.kind === "thinking" && thinking.redacted).toBe(true)
		expect(thinking?.kind === "thinking" && thinking.text).toBeUndefined()
	})

	// The Vercel AI SDK records the request but not the reply.
	it("renders a captured prompt with no captured reply as a prompt block", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						inputMessages: [{ role: "user", parts: [{ type: "text", content: "the turn prompt" }] }],
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "reply" }] }],
					},
				}),
				llmSpan({
					spanId: "l2",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					serviceName: "search-service",
					genAi: {
						inputMessages: [{ role: "user", parts: [{ type: "text", content: "summarise progress" }] }],
					},
				}),
			],
		})

		const rows = transcript(spans)
		const prompt = rows.find((row) => row.kind === "prompt")
		expect(prompt?.kind === "prompt" && prompt.text).toBe("summarise progress")
		// The seam is named once, where the emitter changed.
		const boundary = rows.find((row) => row.kind === "note" && row.noteKind === "capture-boundary")
		expect(boundary?.kind === "note" && boundary.serviceName).toBe("search-service")
		// This emitter records the request and not the reply — say which, rather
		// than "some content is missing".
		expect(boundary?.kind === "note" && boundary.captures).toBe("input")
	})

	// The user row already printed those words; a prompt block would repeat them.
	// The missing reply still has to be said — as an empty assistant block.
	it("does not repeat the turn's opening prompt as a prompt block", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						inputMessages: [{ role: "user", parts: [{ type: "text", content: "the only prompt" }] }],
					},
				}),
			],
		})

		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "user", "assistant"])
		const assistant = rows.find((row) => row.kind === "assistant")
		expect(assistant?.kind === "assistant" && assistant.text).toBeUndefined()
		expect(assistant?.kind === "assistant" && assistant.failed).toBe(false)
	})
})

describe("buildTranscript — tool calls", () => {
	it("merges a tool span's arguments and result into one card", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: {
						toolCallId: "toolu_1",
						toolCallArguments: { sql: "SELECT 1" },
						toolCallResult: "1 row",
					},
				}),
			],
		})

		const tool = transcript(spans).find((row) => row.kind === "tool")
		expect(tool?.kind === "tool" && tool.toolName).toBe("run_sql")
		expect(tool?.kind === "tool" && tool.args?.text).toBe('{"sql":"SELECT 1"}')
		expect(tool?.kind === "tool" && tool.result?.text).toBe("1 row")
	})

	// A missing result is not a successful one.
	it("leaves a tool call with no captured result empty rather than implying success", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					toolName: "inspect_trace",
					genAi: { toolCallId: "toolu_1", toolCallArguments: { trace_id: "abc" } },
				}),
			],
		})

		const tool = transcript(spans).find((row) => row.kind === "tool")
		expect(tool?.kind === "tool" && tool.result).toBeUndefined()
		expect(tool?.kind === "tool" && tool.failed).toBe(false)
	})

	it("resolves a result echoed into a later call's input history", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: { toolCallId: "toolu_1", toolCallArguments: { sql: "SELECT 1" } },
				}),
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					genAi: {
						inputMessages: [
							{
								role: "tool",
								parts: [{ type: "tool_call_response", id: "toolu_1", result: "62 rows" }],
							},
						],
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "done" }] }],
					},
				}),
			],
		})

		const tool = transcript(spans).find((row) => row.kind === "tool")
		expect(tool?.kind === "tool" && tool.result?.text).toBe("62 rows")
	})

	it("renders a tool call known only from an output message, once", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						outputMessages: [
							{
								role: "assistant",
								parts: [
									{ type: "text", content: "calling out" },
									{ type: "tool_call", id: "toolu_9", name: "web_search", arguments: { q: "x" } },
								],
							},
						],
					},
				}),
			],
		})

		const tools = transcript(spans).filter((row) => row.kind === "tool")
		expect(tools).toHaveLength(1)
		expect(tools[0]!.fromMessageOnly).toBe(true)
		expect(tools[0]!.toolName).toBe("web_search")
	})

	it("does not double-count a call that both a message and a tool span describe", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: {
						outputMessages: [
							{
								role: "assistant",
								parts: [{ type: "tool_call", id: "toolu_1", name: "run_sql", arguments: {} }],
							},
						],
					},
				}),
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 2 * SECOND,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: { toolCallId: "toolu_1", toolCallResult: "ok" },
				}),
			],
		})

		const tools = transcript(spans).filter((row) => row.kind === "tool")
		expect(tools).toHaveLength(1)
		expect(tools[0]!.fromMessageOnly).toBe(false)
	})

	it("marks an errored tool call in place", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					toolName: "run_sql",
					statusCode: "Error",
					statusMessage: "Timeout exceeded",
					genAi: { toolCallId: "toolu_1", errorType: "TIMEOUT_EXCEEDED" },
				}),
			],
		})

		const tool = transcript(spans).find((row) => row.kind === "tool")
		expect(tool?.kind === "tool" && tool.failed).toBe(true)
	})
})

describe("payload", () => {
	it("measures what is there", () => {
		expect(payload("ab\ncd")).toEqual({
			text: "ab\ncd",
			byteLength: 5,
			lineCount: 2,
			truncatedByEmitter: false,
		})
	})

	it("counts multi-byte characters as the bytes they are", () => {
		expect(payload("é…")?.byteLength).toBe(5)
	})

	// Emitter truncation is not the view's clamping: there is no "show full".
	it("unwraps a {truncated, prefix} envelope and flags it", () => {
		const result = payload(JSON.stringify({ truncated: true, prefix: "stmt calls p95_ms\n" }))
		expect(result?.text).toBe("stmt calls p95_ms\n")
		expect(result?.truncatedByEmitter).toBe(true)
	})

	it("flags a trailing truncation marker and strips it from the body", () => {
		const result = payload("the first 8 KB of rows…[truncated]")
		expect(result?.text).toBe("the first 8 KB of rows")
		expect(result?.truncatedByEmitter).toBe(true)
	})

	it("leaves ordinary JSON that happens to mention truncation alone", () => {
		const result = payload(JSON.stringify({ truncated: false, rows: 3 }))
		expect(result?.truncatedByEmitter).toBe(false)
		expect(result?.text).toBe('{"truncated":false,"rows":3}')
	})

	it("reports nothing for nothing", () => {
		expect(payload(undefined)).toBeUndefined()
		expect(payload("")).toBeUndefined()
	})
})

describe("buildTranscript — structural fallback and notes", () => {
	const structural = turnSpans({
		agentName: "reindex-agent",
		startMs: 0,
		durationMs: 10 * SECOND,
		children: [
			llmSpan({
				spanId: "l1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: 2 * SECOND,
				model: "gpt-5",
				genAi: { usageInputTokens: 1200, usageOutputTokens: 300 },
			}),
			toolSpan({
				spanId: "t1",
				parentSpanId: "agent",
				startMs: 3 * SECOND,
				durationMs: SECOND,
				toolName: "list_shards",
			}),
		],
	})

	it("falls back to structure rows when nothing was captured", () => {
		const rows = transcript(structural)
		expect(kinds(rows)).toEqual(["note", "turn", "structure", "tool"])
		const structure = rows.find((row) => row.kind === "structure")
		expect(structure?.kind === "structure" && structure.label).toBe("chat gpt-5")
	})

	// One note for the session, not one per silent span.
	it("says content is missing once, at the top, rather than per span", () => {
		const notes = transcript(structural).filter((row) => row.kind === "note")
		expect(notes).toHaveLength(1)
		expect(notes[0]!.noteKind).toBe("capture-off")
		expect(notes[0]!.anyCaptured).toBe(false)
	})

	it("moves the note into the turn when the rest of the session does capture", () => {
		const captured = (index: number) =>
			turnSpans({
				agentId: `agent-${index}`,
				traceId: `trace-${index}`,
				startMs: index * 60 * SECOND,
				durationMs: 10 * SECOND,
				children: [
					llmSpan({
						spanId: `l-${index}`,
						parentSpanId: `agent-${index}`,
						startMs: index * 60 * SECOND,
						durationMs: SECOND,
						genAi: {
							inputMessages: [{ role: "user", parts: [{ type: "text", content: `q${index}` }] }],
							outputMessages: [{ role: "assistant", parts: [{ type: "text", content: `a${index}` }] }],
						},
					}),
				],
			})
		const silent = turnSpans({
			agentId: "agent-9",
			traceId: "trace-9",
			startMs: 600 * SECOND,
			durationMs: 10 * SECOND,
			children: [
				llmSpan({ spanId: "l-9", parentSpanId: "agent-9", startMs: 600 * SECOND, durationMs: SECOND }),
			],
		})

		const rows = transcript([...captured(0), ...captured(1), ...captured(2), ...silent])
		// No leading banner: capture is the norm in this session.
		expect(rows[0]!.kind).toBe("turn")
		const noteIndex = rows.findIndex((row) => row.kind === "note")
		expect(rows[noteIndex - 1]!.kind).toBe("turn")
	})
})

describe("buildTranscript — session-level states", () => {
	const simple = turnSpans({
		startMs: 0,
		durationMs: 5 * SECOND,
		children: [
			llmSpan({
				spanId: "l1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "hi" }] }] },
			}),
		],
	})

	// The END of the session is what truncation drops, so the divider is last.
	it("closes a truncated session on a terminal divider", () => {
		const rows = transcript(simple, { truncated: true })
		const last = rows.at(-1)
		expect(last?.kind === "divider" && last.dividerKind).toBe("truncated")
	})

	it("adds no divider to a whole session", () => {
		expect(kinds(transcript(simple))).not.toContain("divider")
	})

	it("renders nothing at all for a session with no AI spans", () => {
		const spans = [
			llmSpan({ spanId: "http", startMs: 0, durationMs: SECOND, isAiSpan: false, genAi: {} }),
		]
		expect(transcript(spans)).toHaveLength(0)
	})

	it("marks the compaction point in flow, before the call that reports it", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: { outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "a" }] }] },
				}),
				llmSpan({
					spanId: "l2",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					genAi: {
						conversationCompacted: true,
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "b" }] }],
					},
				}),
			],
		})

		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "assistant", "divider", "assistant"])
		const divider = rows.find((row) => row.kind === "divider")
		expect(divider?.kind === "divider" && divider.dividerKind).toBe("compaction")
	})

	// A retry is an errored call followed by a successful one — never one merged
	// "eventually succeeded" event.
	it("keeps a failed call and its retry as two blocks", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "prompt is 198,214 tokens",
					genAi: { errorType: "context_length_exceeded" },
				}),
				llmSpan({
					spanId: "l2",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					genAi: {
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "retried fine" }] }],
					},
				}),
			],
		})

		const assistants = transcript(spans).filter((row) => row.kind === "assistant")
		expect(assistants.map((row) => [row.failed, row.text])).toEqual([
			[true, undefined],
			[false, "retried fine"],
		])
	})

	it("drops the app's own HTTP spans and de-duplicates repeated span ids", () => {
		const tool = toolSpan({
			spanId: "t1",
			parentSpanId: "agent",
			startMs: 0,
			durationMs: SECOND,
			toolName: "run_sql",
		})
		const spans = [
			...turnSpans({ startMs: 0, durationMs: 5 * SECOND, children: [tool, tool] }),
			{ ...tool, spanId: "http", isAiSpan: false, genAi: {} },
		]
		expect(transcript(spans).filter((row) => row.kind === "tool")).toHaveLength(1)
	})
})

describe("buildTranscript — filter and collapse", () => {
	const spans = turnSpans({
		startMs: 0,
		durationMs: 10 * SECOND,
		children: [
			llmSpan({
				spanId: "l1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: {
					outputMessages: [
						{ role: "assistant", parts: [{ type: "text", content: "the carts lookup is the outlier" }] },
					],
				},
			}),
			toolSpan({
				spanId: "t1",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				toolName: "inspect_trace",
				genAi: { toolCallId: "toolu_1" },
			}),
		],
	})

	it("filters blocks by their text, not only by span name", () => {
		const rows = transcript(spans, { query: "carts" })
		expect(kinds(rows)).toEqual(["turn", "assistant"])
	})

	it("drops a turn whose every block was filtered out", () => {
		expect(transcript(spans, { query: "nothing matches this" })).toHaveLength(0)
	})

	it("keeps a collapsed turn's header and reports what it holds", () => {
		const rows = transcript(spans, { collapsedTurns: new Set(["span:agent"]) })
		expect(kinds(rows)).toEqual(["turn"])
		const header = rows[0]
		expect(header?.kind === "turn" && header.llmCalls).toBe(1)
		expect(header?.kind === "turn" && header.toolCalls).toBe(1)
		expect(header?.kind === "turn" && header.toolNames).toEqual(["inspect_trace"])
	})
})
