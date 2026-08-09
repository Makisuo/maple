import { afterAll, beforeAll } from "vitest"
import { generateText, stepCountIs } from "ai"
import { ToolCallScorer, type TaskResult, type ToolCall } from "vitest-evals"
import { describeMapleEval, FIXTURES } from "./utils"
import { createEvalModel, hasEvalCredentials } from "./model"
import { buildExecutionToolSet } from "./tools"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import { makeEvalRuntime, type EvalRuntime } from "./eval-runtime"
import { OutputContainsScorer } from "./scorers"
import { LARGE_TRACE_SPAN_COUNT } from "./fixtures"

let rt: EvalRuntime | undefined

beforeAll(() => {
	if (!hasEvalCredentials()) return
	installFakeWarehouse()
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	if (rt) await rt.dispose()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractText = (toolResult: any): string => {
	const out = toolResult?.output ?? toolResult?.result
	const content = out?.content
	if (Array.isArray(content)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return content.map((c: any) => c?.text ?? "").join("\n")
	}
	return typeof out === "string" ? out : ""
}

// Full-execution eval: the model actually calls inspect_trace, which runs end
// to end against the fake warehouse (150-span trace). Verifies the Part-1
// bounded-overview behavior surfaces through a real model + the real renderer.
describeMapleEval("observability tool execution (fake warehouse)", {
	data: async () => [
		{
			input: `Inspect trace ${FIXTURES.traceId} and tell me where the time went.`,
			expectedTools: [{ name: "inspect_trace" }],
		},
	],
	task: async (input: string): Promise<TaskResult> => {
		const result = await generateText({
			model: createEvalModel(),
			temperature: 0,
			tools: buildExecutionToolSet(rt!.runtime, rt!.tenant),
			stopWhen: stepCountIs(6),
			messages: [{ role: "user", content: input }],
		})
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const steps = result.steps as any[]
		const toolCalls: ToolCall[] = steps.flatMap((step) =>
			(step.toolCalls ?? []).map((call: { toolName: string; input?: unknown }) => ({
				name: call.toolName,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				arguments: (call.input ?? {}) as Record<string, any>,
			})),
		)
		// Fold rendered tool output into `result` so OutputContainsScorer (which
		// reads opts.output) can assert on the bounded-overview text.
		const toolText = steps
			.flatMap((step) => step.toolResults ?? [])
			.map(extractText)
			.join("\n")
		return { result: `${toolText}\n${result.text}`, toolCalls }
	},
	scorers: [
		ToolCallScorer({ requireAll: false, params: "fuzzy" }),
		OutputContainsScorer({
			mustContain: ["Showing", `of ${LARGE_TRACE_SPAN_COUNT} spans (errors and longest first)`],
		}),
	],
	threshold: 0.7,
})
