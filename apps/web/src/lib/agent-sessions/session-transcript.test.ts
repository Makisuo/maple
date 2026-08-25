import { describe, expect, it } from "vitest"

import type { AiSessionSpan } from "@maple/domain/http"

import { buildAgentSessionFixture } from "@/lab/agent-session-fixture"

import { buildSessionTurns } from "./session-turns"
import { buildTranscript, payload, type TranscriptInput, type TranscriptRow } from "./session-transcript"
import { sessionToolResults } from "./span-detail"
import { agentSpan, llmSpan, makeSpan, toolSpan, T0 } from "./span-test-support"

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

/**
 * The one row of a kind, or a failure.
 *
 * `rows.find(...)?.kind === "tool" && row.failed` is happy either way — it
 * passes when the row is missing, which is exactly the regression a test of the
 * row's contents is meant to catch.
 */
function findRow<K extends TranscriptRow["kind"]>(
	rows: readonly TranscriptRow[],
	kind: K,
): Extract<TranscriptRow, { kind: K }> {
	const row = rows.find((candidate) => candidate.kind === kind)
	if (row === undefined) throw new Error(`no ${kind} row in [${kinds(rows).join(", ")}]`)
	return row as Extract<TranscriptRow, { kind: K }>
}

function findRows<K extends TranscriptRow["kind"]>(
	rows: readonly TranscriptRow[],
	kind: K,
): readonly Extract<TranscriptRow, { kind: K }>[] {
	return rows.filter((row): row is Extract<TranscriptRow, { kind: K }> => row.kind === kind)
}

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
							{
								role: "user",
								parts: [{ type: "text", content: "p95 tripled — find what changed" }],
							},
						],
						outputMessages: [
							{
								role: "assistant",
								parts: [{ type: "text", content: "reading the traces first" }],
							},
						],
					},
				}),
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 3 * SECOND,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: {
						toolCallId: "toolu_1",
						toolCallArguments: { sql: "SELECT 1" },
						toolCallResult: "1",
					},
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
			toolSpan({
				spanId: "a1",
				parentSpanId: "lane-a",
				startMs: 3 * SECOND,
				durationMs: 500,
				toolName: "run_sql",
			}),
			toolSpan({
				spanId: "b1",
				parentSpanId: "lane-b",
				startMs: 4 * SECOND,
				durationMs: 500,
				toolName: "inspect_trace",
			}),
			toolSpan({
				spanId: "a2",
				parentSpanId: "lane-a",
				startMs: 5 * SECOND,
				durationMs: 500,
				toolName: "run_sql",
			}),
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

		const marker = findRow(rows, "parallel")
		expect(marker.forkedBy).toBe("planner-agent")
		expect(marker.lanes).toHaveLength(2)
		// The fork runs forwards, and both lanes really were open together.
		expect(marker.startMs).toBeLessThan(marker.endMs)
		expect(marker.overlapStartMs).toBe(T0 + 2 * SECOND)
		expect(marker.overlapEndMs).toBe(T0 + 21 * SECOND)
		// The marker sits in the thread that forked, not inside either lane.
		expect(marker.depth).toBe(0)
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
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: 5 * SECOND,
					toolName: "a",
				}),
				toolSpan({
					spanId: "t2",
					parentSpanId: "agent",
					startMs: SECOND,
					durationMs: 5 * SECOND,
					toolName: "b",
				}),
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
		const open = findRow(rows, "lane-open")
		expect(open.laneKind).toBe("subagent")
		expect(open.parentAgentName).toBe("db-lane")
		// A lane opens one level in from the thread that forked it, and its rows
		// sit alongside it.
		expect(open.depth).toBe(1)
		expect(findRow(rows, "tool").depth).toBe(1)
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
			llmSpan({
				spanId: "l2",
				parentSpanId: "lane",
				startMs: 3 * SECOND,
				durationMs: SECOND,
				model: "m",
			}),
			toolSpan({
				spanId: "t1",
				parentSpanId: "lane",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				toolName: "run_sql",
			}),
		]

		const rows = transcript(spans)
		const close = findRow(rows, "lane-close")
		expect(close.llmCalls).toBe(2)
		expect(close.toolCalls).toBe(1)
		expect(close.durationMs).toBe(12 * SECOND)
		expect(findRow(rows, "lane-open").spanCount).toBe(3)
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
					genAi: {
						inputMessages: history,
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "ok" }] }],
					},
				}),
				llmSpan({
					spanId: "l2",
					parentSpanId: "agent",
					startMs: 2 * SECOND,
					durationMs: SECOND,
					genAi: {
						inputMessages: [
							...history,
							{ role: "user", parts: [{ type: "text", content: "re-sent" }] },
						],
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

		const thinking = findRow(transcript(spans), "thinking")
		expect(thinking.redacted).toBe(true)
		expect(thinking.text).toBeUndefined()
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
						inputMessages: [
							{ role: "user", parts: [{ type: "text", content: "the turn prompt" }] },
						],
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
						inputMessages: [
							{ role: "user", parts: [{ type: "text", content: "summarise progress" }] },
						],
					},
				}),
			],
		})

		const rows = transcript(spans)
		expect(findRow(rows, "prompt").text).toBe("summarise progress")
		// The seam is named once, where the emitter changed.
		const boundary = findRow(rows, "note")
		if (boundary.noteKind !== "capture-boundary") throw new Error("expected a boundary note")
		expect(boundary.serviceName).toBe("search-service")
		// This emitter records the request and not the reply — say which, rather
		// than "some content is missing".
		expect(boundary.captures).toBe("input")
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
						inputMessages: [
							{ role: "user", parts: [{ type: "text", content: "the only prompt" }] },
						],
					},
				}),
			],
		})

		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "user", "assistant"])
		const assistant = findRow(rows, "assistant")
		expect(assistant.text).toBeUndefined()
		expect(assistant.failed).toBe(false)
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

		const tool = findRow(transcript(spans), "tool")
		expect(tool.toolName).toBe("run_sql")
		expect(tool.args?.text).toBe('{"sql":"SELECT 1"}')
		expect(tool.result?.text).toBe("1 row")
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

		const tool = findRow(transcript(spans), "tool")
		expect(tool.result).toBeUndefined()
		expect(tool.failed).toBe(false)
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

		expect(findRow(transcript(spans), "tool").result?.text).toBe("62 rows")
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
									{
										type: "tool_call",
										id: "toolu_9",
										name: "web_search",
										arguments: { q: "x" },
									},
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

		expect(findRow(transcript(spans), "tool").failed).toBe(true)
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

	it("unwraps the `value` and `content` spellings of the same envelope", () => {
		expect(payload(JSON.stringify({ truncated: true, value: "first rows" }))?.text).toBe("first rows")
		expect(payload(JSON.stringify({ truncated: true, content: "first rows" }))?.text).toBe("first rows")
	})

	// `{ rows: [...], truncated: true }` is a RESULT reporting its own truncation,
	// not a wrapper around a prefix: unwrapping it would throw the rows away.
	it("renders a data-bearing object that reports its own truncation in full", () => {
		const text = JSON.stringify({ rows: [1, 2, 3], truncated: true })
		expect(payload(text)).toStrictEqual({
			text,
			byteLength: text.length,
			lineCount: 1,
			truncatedByEmitter: false,
		})
	})

	// The emitter recorded that it cut the payload and kept none of it. There is
	// nothing to show, and saying so is not the same as showing an empty payload.
	it("keeps the truncation flag on an envelope with no prefix", () => {
		expect(payload(JSON.stringify({ truncated: true }))).toStrictEqual({
			text: "",
			byteLength: 0,
			lineCount: 0,
			truncatedByEmitter: true,
		})
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
		expect(findRow(rows, "structure").label).toBe("chat gpt-5")
	})

	// One note for the session, not one per silent span.
	it("says content is missing once, at the top, rather than per span", () => {
		const notes = transcript(structural).filter((row) => row.kind === "note")
		expect(notes).toHaveLength(1)
		const note = notes[0]!
		expect(note.noteKind).toBe("capture-off")
		expect(note.noteKind === "capture-off" && note.anyCaptured).toBe(false)
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
							inputMessages: [
								{ role: "user", parts: [{ type: "text", content: `q${index}` }] },
							],
							outputMessages: [
								{ role: "assistant", parts: [{ type: "text", content: `a${index}` }] },
							],
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
				llmSpan({
					spanId: "l-9",
					parentSpanId: "agent-9",
					startMs: 600 * SECOND,
					durationMs: SECOND,
				}),
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
		if (last?.kind !== "divider") throw new Error("expected a terminal divider")
		expect(last.dividerKind).toBe("truncated")
	})

	it("adds no divider to a whole session", () => {
		expect(kinds(transcript(simple))).not.toContain("divider")
	})

	it("renders nothing at all for a session with no AI spans", () => {
		const spans = [
			makeSpan({ spanId: "http", spanName: "GET /checkout", startMs: 0, durationMs: SECOND }),
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
					genAi: {
						outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "a" }] }],
					},
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
		expect(findRow(rows, "divider").dividerKind).toBe("compaction")
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
						outputMessages: [
							{ role: "assistant", parts: [{ type: "text", content: "retried fine" }] },
						],
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
			makeSpan({
				spanId: "http",
				parentSpanId: "agent",
				spanName: "SELECT carts",
				startMs: 0,
				durationMs: SECOND,
			}),
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
						{
							role: "assistant",
							parts: [{ type: "text", content: "the carts lookup is the outlier" }],
						},
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
		const header = findRow(rows, "turn")
		expect(header.llmCalls).toBe(1)
		expect(header.toolCalls).toBe(1)
		expect(header.aiSpanCount).toBe(3)
		expect(header.toolNames).toEqual(["inspect_trace"])
	})
})

describe("buildTranscript — parallel clustering", () => {
	/** Three lanes under one parent, each overlapping only its neighbour. */
	const chain = [
		agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND, agentName: "planner-agent" }),
		agentSpan({
			spanId: "lane-a",
			parentSpanId: "agent",
			startMs: SECOND,
			durationMs: 10 * SECOND,
			agentName: "a-lane",
		}),
		agentSpan({
			spanId: "lane-b",
			parentSpanId: "agent",
			startMs: 5 * SECOND,
			durationMs: 10 * SECOND,
			agentName: "b-lane",
		}),
		agentSpan({
			spanId: "lane-c",
			parentSpanId: "agent",
			startMs: 12 * SECOND,
			durationMs: 8 * SECOND,
			agentName: "c-lane",
		}),
	]

	it("keeps a staggered run in one cluster and links only the pairs that overlapped", () => {
		const rows = transcript(chain)
		const marker = findRow(rows, "parallel")
		expect(marker.lanes.map((lane) => lane.agentName)).toEqual(["a-lane", "b-lane", "c-lane"])
		// The window runs forwards, whatever the stagger does.
		expect(marker.startMs).toBe(T0 + SECOND)
		expect(marker.endMs).toBe(T0 + 20 * SECOND)
		// A chain has no window all three shared, and the marker says so rather
		// than reporting one that runs backwards.
		expect(marker.overlapStartMs).toBeUndefined()
		expect(marker.overlapEndMs).toBeUndefined()

		const opens = findRows(rows, "lane-open")
		expect(opens.map((row) => row.parallelWith.map((ref) => ref.agentName))).toEqual([
			["b-lane"],
			["a-lane", "c-lane"],
			["b-lane"],
		])
	})

	// The lane that breaks the run under a "previous member" rule: it ends before
	// the next one starts, while the long lane above it is still open.
	it("clusters two short lanes nested inside one long one", () => {
		const nested = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND, agentName: "planner-agent" }),
			agentSpan({
				spanId: "lane-long",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 29 * SECOND,
				agentName: "long-lane",
			}),
			agentSpan({
				spanId: "lane-x",
				parentSpanId: "agent",
				startMs: 3 * SECOND,
				durationMs: 3 * SECOND,
				agentName: "x-lane",
			}),
			agentSpan({
				spanId: "lane-y",
				parentSpanId: "agent",
				startMs: 10 * SECOND,
				durationMs: 4 * SECOND,
				agentName: "y-lane",
			}),
		]

		const rows = transcript(nested)
		expect(findRows(rows, "parallel")).toHaveLength(1)
		const marker = findRow(rows, "parallel")
		expect(marker.lanes).toHaveLength(3)
		expect(marker.startMs).toBeLessThan(marker.endMs)

		const opens = findRows(rows, "lane-open")
		expect(opens.map((row) => row.parallelWith.map((ref) => ref.agentName))).toEqual([
			["x-lane", "y-lane"],
			["long-lane"],
			["long-lane"],
		])
	})
})

describe("buildTranscript — what counts as a captured reply", () => {
	const outputOnly = (parts: readonly unknown[], extra: readonly AiSessionSpan[] = []) =>
		turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: { outputMessages: [{ role: "assistant", parts }] },
				}),
				...extra,
			],
		})

	// A call that produced a tool call produced output; the span that ran the
	// tool is the row, and there is no missing reply to report.
	it("does not claim a missing reply when the output was a tool call a span covers", () => {
		const spans = outputOnly(
			[{ type: "tool_call", id: "toolu_1", name: "run_sql", arguments: { sql: "SELECT 1" } }],
			[
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 2 * SECOND,
					durationMs: SECOND,
					toolName: "run_sql",
					genAi: { toolCallId: "toolu_1", toolCallResult: "1 row" },
				}),
			],
		)
		expect(kinds(transcript(spans))).toEqual(["turn", "tool"])
	})

	// The Thinking chip is a view choice. It cannot turn a call that reasoned and
	// then went to work into one whose reply was never recorded.
	it("keeps the capture claim the same with Thinking on and off", () => {
		const spans = outputOnly([{ type: "thinking", thinking: "the carts read is the outlier" }])
		expect(kinds(transcript(spans))).toEqual(["turn", "thinking"])
		expect(kinds(transcript(spans, { showThinking: false }))).toEqual(["turn"])
	})

	it("still reports a missing reply when the call captured no output at all", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: { systemInstructions: "be terse" },
				}),
			],
		})
		const assistant = findRow(transcript(spans), "assistant")
		expect(assistant.text).toBeUndefined()
		expect(assistant.failed).toBe(false)
	})

	// A failed call that still captured text: the text is what it managed to say
	// before it errored, and dropping it would lose the only evidence there is.
	it("keeps a failed call's captured text on its row", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "stream closed",
					genAi: {
						errorType: "stream_error",
						outputMessages: [
							{ role: "assistant", parts: [{ type: "text", content: "reading the" }] },
						],
					},
				}),
			],
		})
		const assistant = findRow(transcript(spans), "assistant")
		expect(assistant.text).toBe("reading the")
		expect(assistant.failed).toBe(true)
	})

	// An emitter that omits ids in its messages usually omits them on its spans
	// too, and then the call has nowhere to be matched but its name.
	it("drops an id-less message-only tool call the tool span already reports", () => {
		const spans = outputOnly(
			[{ type: "tool_call", name: "run_sql", arguments: { sql: "SELECT 1" } }],
			[
				toolSpan({
					spanId: "t1",
					parentSpanId: "agent",
					startMs: 2 * SECOND,
					durationMs: SECOND,
					toolName: "run_sql",
				}),
			],
		)
		const tools = findRows(transcript(spans), "tool")
		expect(tools).toHaveLength(1)
		expect(tools[0]!.fromMessageOnly).toBe(false)
	})

	it("keeps the message-only row when no span could be the same call", () => {
		const spans = outputOnly([{ type: "tool_call", name: "web_search", arguments: { q: "x" } }])
		const tools = findRows(transcript(spans), "tool")
		expect(tools).toHaveLength(1)
		expect(tools[0]!.fromMessageOnly).toBe(true)
	})
})

describe("buildTranscript — capture notes", () => {
	const call = (index: number, serviceName: string, genAi: Record<string, unknown>) =>
		llmSpan({
			spanId: `l${index}`,
			parentSpanId: "agent",
			startMs: index * SECOND,
			durationMs: 500,
			serviceName,
			genAi,
		})

	// The note names what the NEW emitter records, and the first call after the
	// seam is exactly the one most likely to have errored before recording.
	it("reads a boundary's coverage from every call the new service made", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				call(1, "planner", {
					inputMessages: [{ role: "user", parts: [{ type: "text", content: "go" }] }],
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "on it" }] }],
				}),
				call(2, "search-service", { errorType: "rate_limited" }),
				call(3, "search-service", {
					inputMessages: [{ role: "user", parts: [{ type: "text", content: "again" }] }],
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "found it" }] }],
				}),
			],
		})

		const boundary = findRow(transcript(spans), "note")
		if (boundary.noteKind !== "capture-boundary") throw new Error("expected a boundary note")
		expect(boundary.serviceName).toBe("search-service")
		expect(boundary.captures).toBe("both")
	})

	// The same service capturing nothing on one call is a per-call absence, and
	// that call's own row already says so.
	it("says nothing at a seam that is not a change of emitter", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 10 * SECOND,
			children: [
				call(1, "planner", {
					outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "on it" }] }],
				}),
				call(2, "planner", {}),
			],
		})
		expect(kinds(transcript(spans))).not.toContain("note")
	})

	// System instructions are not the conversation: a session that captured only
	// those has captured nothing the reader came for.
	it("raises the banner for a session that captured system prompts and nothing else", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "l1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					genAi: { systemInstructions: "you are the planner" },
				}),
			],
		})

		const rows = transcript(spans)
		const note = findRow(rows, "note")
		if (note.noteKind !== "capture-off") throw new Error("expected a capture-off note")
		expect(rows[0]).toBe(note)
		expect(note.scope).toBe("session")
		expect(note.anyCaptured).toBe(false)
		// The instructions still render where they were captured.
		expect(findRow(rows, "system").text).toBe("you are the planner")
	})

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
						outputMessages: [
							{ role: "assistant", parts: [{ type: "text", content: `a${index}` }] },
						],
					},
				}),
			],
		})
	const silent = (index: number) =>
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
				}),
			],
		})

	// Exactly half is not "below half": the banner is for sessions where silence
	// is the norm, and a even split is not one.
	it("holds the banner at exactly half the calls captured", () => {
		const rows = transcript([...captured(0), ...silent(1)])
		expect(rows[0]!.kind).toBe("turn")
	})

	it("raises it once capture is the exception", () => {
		const rows = transcript([...captured(0), ...silent(1), ...silent(2)])
		const note = findRow(rows, "note")
		if (note.noteKind !== "capture-off") throw new Error("expected a capture-off note")
		expect(rows[0]).toBe(note)
		expect(note.anyCaptured).toBe(true)
	})

	// A turn-scope note must not read as a claim about the whole session.
	it("scopes a per-turn note to the turn", () => {
		const rows = transcript([...captured(0), ...captured(1), ...captured(2), ...silent(9)])
		const note = findRow(rows, "note")
		if (note.noteKind !== "capture-off") throw new Error("expected a capture-off note")
		expect(note.scope).toBe("turn")
		expect(note.anyCaptured).toBe(false)
	})
})

describe("buildTranscript — delegation payloads", () => {
	it("renders the task prompt on the lane it opened and the answer on its close", () => {
		const spans = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 30 * SECOND, agentName: "db-lane" }),
			toolSpan({
				spanId: "task",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 12 * SECOND,
				toolName: "task",
				genAi: {
					toolCallId: "toolu_task",
					toolCallArguments: { prompt: "verify the plan against the schema" },
					toolCallResult: "the plan checks out",
				},
			}),
			agentSpan({
				spanId: "sub",
				parentSpanId: "task",
				startMs: SECOND,
				durationMs: 12 * SECOND,
				agentName: "sql-verifier",
			}),
		]

		const rows = transcript(spans)
		expect(findRow(rows, "lane-open").args?.text).toBe('{"prompt":"verify the plan against the schema"}')
		expect(findRow(rows, "lane-close").result?.text).toBe("the plan checks out")
	})
})

describe("buildTranscript — structure labels", () => {
	// An embedding is inference time, but it is not a model turn: labelling it
	// "chat" would claim an exchange that never happened.
	it("labels a retrieval op by the operation it ran", () => {
		const spans = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [
				llmSpan({
					spanId: "e1",
					parentSpanId: "agent",
					startMs: 0,
					durationMs: SECOND,
					model: "text-embedding-3-large",
					genAi: { operationName: "embeddings" },
				}),
			],
		})
		expect(findRow(transcript(spans), "structure").label).toBe("embeddings text-embedding-3-large")
	})
})

describe("buildTranscript — absent payloads", () => {
	// Captured attributes decode through `Schema.Unknown`, so `null` is what an
	// emitter that wrote JSON null looks like from here. It is not a payload.
	it("treats a null argument or result as not captured, never as the text 'null'", () => {
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
					genAi: { toolCallId: "toolu_1", toolCallArguments: null, toolCallResult: null },
				}),
			],
		})
		const tool = findRow(transcript(spans), "tool")
		expect(tool.args).toBeUndefined()
		expect(tool.result).toBeUndefined()
	})
})

describe("buildTranscript — turns with no agent work", () => {
	it("holds a no-AI turn's ordinal open rather than renumbering the page", () => {
		const spans = [
			llmSpan({
				spanId: "l1",
				traceId: "trace-1",
				startMs: 0,
				durationMs: SECOND,
				genAi: { outputMessages: [{ role: "assistant", parts: [{ type: "text", content: "hi" }] }] },
			}),
			makeSpan({
				spanId: "http",
				traceId: "trace-2",
				spanName: "GET /health",
				startMs: 60 * SECOND,
				durationMs: SECOND,
			}),
		]

		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "assistant", "empty-turn"])
		const empty = findRow(rows, "empty-turn")
		expect(empty.turn.index).toBe(2)
	})
})

describe("buildTranscript — filtering", () => {
	const laneSpans = [
		agentSpan({ spanId: "agent", startMs: 0, durationMs: 30 * SECOND, agentName: "planner-agent" }),
		agentSpan({
			spanId: "lane",
			parentSpanId: "agent",
			startMs: SECOND,
			durationMs: 10 * SECOND,
			agentName: "db-lane",
		}),
		toolSpan({
			spanId: "t1",
			parentSpanId: "lane",
			startMs: 2 * SECOND,
			durationMs: SECOND,
			toolName: "run_sql",
			genAi: { toolCallId: "toolu_1", toolCallArguments: { table: "carts" } },
		}),
	]

	// The chrome that gave a row its indentation is gone with the filter on, so
	// the indentation would point at nothing.
	it("flattens the rows a filter leaves behind", () => {
		const rows = transcript(laneSpans, { query: "carts" })
		expect(kinds(rows)).toEqual(["turn", "tool"])
		expect(findRow(rows, "tool").depth).toBe(0)
	})

	it("drops a collapsed turn on a filter exactly as it drops an open one", () => {
		const collapsedTurns = new Set(["span:agent"])
		expect(transcript(laneSpans, { collapsedTurns, query: "nothing matches" })).toHaveLength(0)
		expect(kinds(transcript(laneSpans, { collapsedTurns, query: "carts" }))).toEqual(["turn"])
	})

	// The empty state says what happened; a banner and a divider over nothing
	// would read as facts about a session the reader cannot see.
	it("renders nothing at all — no note, no divider — when the filter empties the session", () => {
		const silent = turnSpans({
			startMs: 0,
			durationMs: 5 * SECOND,
			children: [llmSpan({ spanId: "l1", parentSpanId: "agent", startMs: 0, durationMs: SECOND })],
		})
		expect(transcript(silent, { query: "zzz", truncated: true })).toHaveLength(0)
	})
})

describe("buildTranscript — row keys", () => {
	// Row keys are the virtualizer's identity AND the disclosure set's, so a
	// collision makes two blocks open and close together.
	it("gives every row of the richest fixture a unique key", () => {
		const spans = buildAgentSessionFixture()
		const rows = buildTranscript({
			turns: buildSessionTurns(spans),
			toolResults: sessionToolResults(spans),
			query: "",
			showThinking: true,
			truncated: true,
			collapsedTurns: new Set(),
		})
		expect(rows.length).toBeGreaterThan(20)
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
	})
})

describe("buildTranscript — parallel turns", () => {
	/**
	 * One turn per conversation id, the partition a Maple fan-out produces: the
	 * parent and each sub-agent carry their own id, so they arrive as siblings
	 * rather than as lanes inside one turn.
	 */
	function conversationTurn(input: {
		readonly id: string
		readonly agentName: string
		readonly startMs: number
		readonly durationMs: number
		readonly text?: string
	}): readonly AiSessionSpan[] {
		const conversationId = `conv-${input.id}`
		return [
			agentSpan({
				spanId: `${input.id}-agent`,
				traceId: `trace-${input.id}`,
				startMs: input.startMs,
				durationMs: input.durationMs,
				agentName: input.agentName,
				genAi: { conversationId },
			}),
			llmSpan({
				spanId: `${input.id}-l1`,
				parentSpanId: `${input.id}-agent`,
				traceId: `trace-${input.id}`,
				startMs: input.startMs,
				durationMs: SECOND,
				genAi: {
					conversationId,
					outputMessages: [
						{
							role: "assistant",
							parts: [{ type: "text", content: input.text ?? input.agentName }],
						},
					],
				},
			}),
		]
	}

	/** Two turns open at once: B starts while A is still running. */
	const twoTurns = [
		...conversationTurn({ id: "a", agentName: "log-lane", startMs: 0, durationMs: 20 * SECOND }),
		...conversationTurn({
			id: "b",
			agentName: "metric-lane",
			startMs: 5 * SECOND,
			durationMs: 20 * SECOND,
		}),
	]

	it("splits a fan-out into sibling turns and marks the pair", () => {
		const rows = transcript(twoTurns)
		expect(kinds(rows).slice(0, 2)).toEqual(["parallel-turns", "turn"])

		const marker = findRow(rows, "parallel-turns")
		expect(marker.depth).toBe(0)
		expect(marker.turns.map((ref) => ref.turn.agentName)).toEqual(["log-lane", "metric-lane"])
		// The run's extent, and the window both turns really were open in.
		expect(marker.startMs).toBe(T0)
		expect(marker.endMs).toBe(T0 + 25 * SECOND)
		expect(marker.overlapStartMs).toBe(T0 + 5 * SECOND)
		expect(marker.overlapEndMs).toBe(T0 + 20 * SECOND)
	})

	// The indentation is what makes the fork legible from the middle of a long
	// chapter, where the marker has long scrolled away.
	it("indents every cluster member one lane under the marker", () => {
		const rows = transcript(twoTurns)
		expect(findRow(rows, "parallel-turns").depth).toBe(0)
		for (const header of findRows(rows, "turn")) expect(header.depth).toBe(1)
		// The members' own rows shift with their headers.
		for (const row of findRows(rows, "assistant")) expect(row.depth).toBe(1)
	})

	it("keeps sequential turns on the margin", () => {
		const sequential = [
			...conversationTurn({ id: "a", agentName: "a-lane", startMs: 0, durationMs: 5 * SECOND }),
			...conversationTurn({
				id: "b",
				agentName: "b-lane",
				startMs: 10 * SECOND,
				durationMs: 5 * SECOND,
			}),
		]
		const rows = transcript(sequential)
		for (const header of findRows(rows, "turn")) expect(header.depth).toBe(0)
		for (const row of findRows(rows, "assistant")) expect(row.depth).toBe(0)
	})

	it("gives each member turn header reciprocal jump data", () => {
		const rows = transcript(twoTurns)
		const headers = findRows(rows, "turn")
		expect(headers.map((row) => row.turn.agentName)).toEqual(["log-lane", "metric-lane"])
		expect(headers[0]!.parallelWith.map((ref) => ref.turn.agentName)).toEqual(["metric-lane"])
		expect(headers[1]!.parallelWith.map((ref) => ref.turn.agentName)).toEqual(["log-lane"])
		// The links point at the other turn's own header row key.
		expect(headers[0]!.parallelWith[0]!.key).toBe(headers[1]!.key)
		expect(headers[1]!.parallelWith[0]!.key).toBe(headers[0]!.key)
	})

	// The marker's jump targets have to be row keys, not turn-shaped lookalikes:
	// a key that resolves to nothing scrolls nowhere and reports no error.
	it("resolves every jump key to a row that is on the page", () => {
		const rows = transcript(twoTurns)
		const keys = new Set(rows.map((row) => row.key))
		const marker = findRow(rows, "parallel-turns")
		for (const ref of marker.turns) expect(keys.has(ref.key)).toBe(true)
		for (const header of findRows(rows, "turn")) {
			for (const ref of header.parallelWith) expect(keys.has(ref.key)).toBe(true)
		}
	})

	it("keeps the marker and the chip data on a collapsed member", () => {
		const rows = transcript(twoTurns, { collapsedTurns: new Set(["conversation:conv-a"]) })
		// Collapse hides a turn's body, never its header — so the chapter-level
		// concurrency survives it.
		expect(kinds(rows)).toEqual(["parallel-turns", "turn", "turn", "assistant"])
		const collapsed = findRows(rows, "turn")[0]!
		expect(collapsed.parallelWith.map((ref) => ref.turn.agentName)).toEqual(["metric-lane"])
	})

	it("keeps a staggered run in one cluster and links only the pairs that overlapped", () => {
		const staggered = [
			...conversationTurn({ id: "a", agentName: "a-lane", startMs: 0, durationMs: 10 * SECOND }),
			...conversationTurn({
				id: "b",
				agentName: "b-lane",
				startMs: 5 * SECOND,
				durationMs: 10 * SECOND,
			}),
			...conversationTurn({
				id: "c",
				agentName: "c-lane",
				startMs: 12 * SECOND,
				durationMs: 8 * SECOND,
			}),
		]
		const rows = transcript(staggered)
		expect(findRows(rows, "parallel-turns")).toHaveLength(1)

		const marker = findRow(rows, "parallel-turns")
		expect(marker.turns.map((ref) => ref.turn.agentName)).toEqual(["a-lane", "b-lane", "c-lane"])
		expect(marker.startMs).toBe(T0)
		expect(marker.endMs).toBe(T0 + 20 * SECOND)
		// A chain has no window all three shared, and the marker says so rather
		// than reporting one that runs backwards.
		expect(marker.overlapStartMs).toBeUndefined()
		expect(marker.overlapEndMs).toBeUndefined()

		expect(
			findRows(rows, "turn").map((row) => row.parallelWith.map((ref) => ref.turn.agentName)),
		).toEqual([["b-lane"], ["a-lane", "c-lane"], ["b-lane"]])
	})

	// The turn that breaks the run under a "previous member" rule: it ends before
	// the next one starts, while the long turn above it is still open.
	it("clusters a short turn nested inside a long one", () => {
		const nested = [
			...conversationTurn({ id: "long", agentName: "long-lane", startMs: 0, durationMs: 30 * SECOND }),
			...conversationTurn({
				id: "x",
				agentName: "x-lane",
				startMs: 3 * SECOND,
				durationMs: 3 * SECOND,
			}),
			...conversationTurn({
				id: "y",
				agentName: "y-lane",
				startMs: 12 * SECOND,
				durationMs: 4 * SECOND,
			}),
		]
		const rows = transcript(nested)
		expect(findRows(rows, "parallel-turns")).toHaveLength(1)

		const marker = findRow(rows, "parallel-turns")
		expect(marker.turns).toHaveLength(3)
		expect(marker.startMs).toBeLessThan(marker.endMs)
		// The two short turns never met each other, so only the long one is shared.
		expect(marker.overlapStartMs).toBeUndefined()
		expect(marker.overlapEndMs).toBeUndefined()

		expect(
			findRows(rows, "turn").map((row) => row.parallelWith.map((ref) => ref.turn.agentName)),
		).toEqual([["x-lane", "y-lane"], ["long-lane"], ["long-lane"]])
	})

	it("says nothing about turns that ran one after the other", () => {
		const sequential = [
			...conversationTurn({ id: "a", agentName: "a-lane", startMs: 0, durationMs: 5 * SECOND }),
			...conversationTurn({
				id: "b",
				agentName: "b-lane",
				startMs: 10 * SECOND,
				durationMs: 5 * SECOND,
			}),
		]
		const rows = transcript(sequential)
		expect(kinds(rows)).not.toContain("parallel-turns")
		for (const header of findRows(rows, "turn")) expect(header.parallelWith).toStrictEqual([])
	})

	// An `empty-turn` stub is HTTP/DB work with no agent activity in it. Pairing
	// one with a real turn would announce a concurrency the reader cannot see.
	it("leaves turns with no AI activity out of a cluster", () => {
		const spans = [
			...conversationTurn({ id: "a", agentName: "a-lane", startMs: 0, durationMs: 20 * SECOND }),
			makeSpan({
				spanId: "http",
				traceId: "trace-http",
				spanName: "GET /checkout",
				startMs: 5 * SECOND,
				durationMs: 10 * SECOND,
				genAi: { conversationId: "conv-http" },
				isAiSpan: false,
			}),
		]
		const rows = transcript(spans)
		expect(kinds(rows)).toEqual(["turn", "assistant", "empty-turn"])
		expect(findRow(rows, "turn").parallelWith).toStrictEqual([])
	})

	// Structural chrome, like the lane markers: the filtered view no longer has
	// the ordering the marker describes.
	it("drops the marker and the chips while a query is active", () => {
		const rows = transcript(twoTurns, { query: "metric-lane" })
		expect(kinds(rows)).toEqual(["turn", "assistant"])
		expect(findRow(rows, "turn").parallelWith).toStrictEqual([])
	})

	it("marks the lab fixture's dispatched fan-out", () => {
		const spans = buildAgentSessionFixture()
		const rows = transcript(spans)
		const marker = findRow(rows, "parallel-turns")
		expect(marker.turns.map((ref) => ref.turn.agentName)).toEqual([
			"release-triage",
			"log-lane",
			"metric-lane",
		])
		// All three really were open together, so the window is reported.
		expect(marker.overlapStartMs).toBeDefined()
		expect(marker.overlapEndMs).toBeDefined()
		expect(marker.overlapStartMs!).toBeLessThan(marker.overlapEndMs!)
	})
})

/**
 * The two halves together: the turn partition files each concurrent lane's
 * spans into its own chapter, and the chapter marker then announces that the
 * chapters ran at once.
 *
 * Shaped like Maple's investigation fan-out — a planner pass, three hypothesis
 * lanes launched together with their own `gen_ai.conversation.id`, a validator
 * pass. Each lane ends on a final chat and an `execute_tool submit_candidate`
 * long after the last lane anchored: the spans a time-ordered partition used to
 * dump into whichever lane started last, where they rendered at depth 0 under a
 * chapter that never ran them.
 */
describe("buildTranscript — investigation fan-out", () => {
	const LANES = ["hypothesis-0", "hypothesis-1", "hypothesis-2"] as const

	function fanout(): readonly AiSessionSpan[] {
		const reply = (content: string) => [{ role: "assistant", parts: [{ type: "text", content }] }]
		return [
			agentSpan({
				spanId: "planner-agent",
				traceId: "trace-inv",
				startMs: 0,
				durationMs: 8 * SECOND,
				agentName: "planner",
				genAi: { conversationId: "inv_1_planner" },
			}),
			...LANES.flatMap((lane, index) => {
				const conversationId = `inv_1_${lane}`
				const opensAt = 10 * SECOND + index * 300
				return [
					agentSpan({
						spanId: `${lane}-agent`,
						traceId: "trace-inv",
						startMs: opensAt,
						durationMs: 120 * SECOND,
						agentName: lane,
						genAi: { conversationId },
					}),
					llmSpan({
						spanId: `${lane}-chat-1`,
						parentSpanId: `${lane}-agent`,
						traceId: "trace-inv",
						startMs: opensAt + SECOND,
						durationMs: 3 * SECOND,
						genAi: { conversationId, outputMessages: reply(`${lane} opening read`) },
					}),
					llmSpan({
						spanId: `${lane}-chat-2`,
						parentSpanId: `${lane}-agent`,
						traceId: "trace-inv",
						startMs: opensAt + 100 * SECOND,
						durationMs: 4 * SECOND,
						genAi: { conversationId, outputMessages: reply(`${lane} final answer`) },
					}),
					toolSpan({
						spanId: `${lane}-submit`,
						parentSpanId: `${lane}-agent`,
						traceId: "trace-inv",
						startMs: opensAt + 110 * SECOND,
						durationMs: SECOND,
						toolName: "submit_candidate",
						genAi: {
							conversationId,
							toolCallId: `call-${lane}`,
							toolCallResult: `${lane} filed`,
						},
					}),
				]
			}),
			agentSpan({
				spanId: "validator-agent",
				traceId: "trace-inv",
				startMs: 140 * SECOND,
				durationMs: 10 * SECOND,
				agentName: "validator",
				genAi: { conversationId: "inv_1_validator" },
			}),
		]
	}

	it("announces the concurrent lanes as chapters that ran at once", () => {
		const rows = transcript(fanout())
		const marker = findRow(rows, "parallel-turns")

		expect(marker.turns.map((ref) => ref.turn.agentName)).toEqual([...LANES])
		// All three really were open together, so a window is reported — and it
		// runs forwards.
		expect(marker.overlapStartMs).toBeDefined()
		expect(marker.overlapEndMs).toBeDefined()
		expect(marker.overlapStartMs!).toBeLessThan(marker.overlapEndMs!)

		// The marker opens the cluster: it sits directly before the first lane's
		// header, and the planner's chapter is untouched ahead of it.
		const markerAt = rows.indexOf(marker)
		const next = rows[markerAt + 1]!
		expect(next.kind).toBe("turn")
		expect(next.kind === "turn" && next.turn.agentName).toBe("hypothesis-0")
	})

	// The heart of it: a lane's final chat and its submit call belong to the lane
	// that ran them, not to whichever lane happened to anchor last.
	it("keeps every lane's tail spans inside that lane's own chapter", () => {
		const rows = transcript(fanout())

		// Walk the flat row list, attributing each span-bearing row to the chapter
		// heading it sits under.
		let chapter: string | undefined
		const byChapter = new Map<string, string[]>()
		for (const row of rows) {
			if (row.kind === "turn") {
				chapter = row.turn.agentName
				byChapter.set(chapter!, [])
				continue
			}
			if (!("span" in row) || chapter === undefined) continue
			byChapter.get(chapter)!.push(row.span.spanId)
		}

		for (const lane of LANES) {
			// The anchor is absorbed into the header, so what renders is the work.
			expect(byChapter.get(lane)).toStrictEqual([`${lane}-chat-1`, `${lane}-chat-2`, `${lane}-submit`])
		}
		// And nothing from a lane leaked into the planner's or validator's chapter.
		expect(byChapter.get("planner")).toStrictEqual([])
		expect(byChapter.get("validator")).toStrictEqual([])
	})

	// The failure mode the mis-partition produced: a tail span whose parent lives
	// in another turn becomes a forest root and renders at depth 0, unattributed,
	// under a chapter that never ran it.
	it("leaves no span rendering under a chapter that did not run it", () => {
		const rows = transcript(fanout())

		let chapter: string | undefined
		for (const row of rows) {
			if (row.kind === "turn") {
				chapter = row.turn.agentName
				continue
			}
			if (!("span" in row)) continue
			// Every lane span's id is prefixed with the lane that ran it.
			const owner = LANES.find((lane) => row.span.spanId.startsWith(`${lane}-`))
			if (owner !== undefined) expect(chapter).toBe(owner)
		}
	})

	// Within-turn lane clustering is a different mechanism on a different shape;
	// the fan-out must not start producing lane rows instead of chapters.
	it("does not turn sibling chapters back into lanes inside one turn", () => {
		const rows = transcript(fanout())
		expect(kinds(rows)).not.toContain("lane-open")
		expect(kinds(rows)).not.toContain("parallel")
		expect(findRows(rows, "turn")).toHaveLength(5)
	})
})
