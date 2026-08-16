import { describe, it } from "vitest"
import { describeEval, type TaskResult, type ToolCall } from "vitest-evals"
import { generateText } from "ai"
import { createEvalModel, hasEvalCredentials } from "./model"
import { buildPredictionToolSet } from "./tools"

/** Stable identifiers used across eval prompts + fixtures. */
export const FIXTURES = {
	orgId: "org_eval",
	service: "api",
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "b7ad6b7169203331",
	/**
	 * A FingerprintHash is a UInt64 rendered as a DECIMAL string
	 * (`CH.toString_($.FingerprintHash)`), not hex — hex was what this fixture
	 * used, and it is the same wrong mental model that makes agents feed
	 * `error_detail` a truncated issue id in production.
	 */
	fingerprint: "11640295108927840024",
	/** A Postgres error-issue id. A DIFFERENT identity space to `fingerprint`. */
	issueId: "2b11d788-6f3a-4c21-9f0e-51c4a8d7e930",
} as const

/**
 * Prediction task: hand the model every MCP tool (no `execute`) and capture
 * which it chooses for `input`, without running anything. vitest-evals passes
 * the returned `toolCalls` to `ToolCallScorer`, which compares them to the data
 * item's `expectedTools`.
 */
export const predictToolCalls = async (input: string): Promise<TaskResult> => {
	const result = await generateText({
		model: createEvalModel(),
		temperature: 0,
		tools: buildPredictionToolSet(),
		toolChoice: "auto",
		messages: [{ role: "user", content: input }],
	})
	const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
		name: call.toolName,
		arguments: (call.input ?? {}) as Record<string, unknown>,
	}))
	return { result: result.text, toolCalls }
}

type DescribeEvalArgs = Parameters<typeof describeEval>

/**
 * `describeEval` that skips (rather than fails) when no OpenRouter key is
 * configured — so `bun run eval` is green locally/CI without secrets.
 */
export const describeMapleEval = (...args: DescribeEvalArgs): void => {
	const [name, options] = args
	if (!hasEvalCredentials()) {
		describe.skip(`[eval] ${String(name)}`, () => {
			it("skipped — set OPENROUTER_API_KEY to run MCP evals", () => {})
		})
		return
	}
	describeEval(name, options)
}
