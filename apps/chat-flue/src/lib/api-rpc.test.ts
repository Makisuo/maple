import { describe, expect, it } from "vitest"
import type { ChatFlueEnv } from "./env.ts"
import { mapleApiRpc } from "./api-rpc.ts"
import { buildSubmitDiagnosisTool, DIAGNOSIS_STATUS } from "./submit-diagnosis.ts"

const report = {
	summary: "Checkout latency doubled after deploy.",
	suspectedCause: "Connection pool regression",
	severityAssessment: "high" as const,
	affectedScope: "checkout-api",
	evidence: [
		{
			traceIds: ["trace-1"],
			logPatterns: ["pool exhausted"],
			relatedServices: ["payments"],
			note: "Correlated evidence",
		},
	],
	suggestedActions: ["Roll back"],
	confidence: "high" as const,
}

const envWithBinding = (binding: Record<string, unknown>): ChatFlueEnv => ({
	AI: { run: async () => ({}) },
	MAPLE_API_RPC: binding as never,
	INTERNAL_SERVICE_TOKEN: "workflow-token",
})

describe("Maple API Worker RPC", () => {
	it("preserves tagged errors across the Alchemy RPC envelope", async () => {
		const api = mapleApiRpc(
			envWithBinding({
				callMcpTool: async () => ({
					_tag: "~alchemy/rpc/error",
					error: {
						_tag: "@maple/internal-rpc/InvalidInputError",
						method: "callMcpTool",
						message: "invalid org",
					},
				}),
			}),
		)

		await expect(api.callMcpTool({ orgId: " ", name: "x", input: {} })).rejects.toMatchObject({
			_tag: "@maple/internal-rpc/InvalidInputError",
			method: "callMcpTool",
		})
	})

	it("submits a diagnosis over RPC and returns the existing render marker", async () => {
		const calls: unknown[] = []
		const env = envWithBinding({
			submitDiagnosis: async (request: unknown) => {
				calls.push(request)
				return { id: "ignored-by-chat" }
			},
		})
		const tool = buildSubmitDiagnosisTool(env, "org_1", "00000000-0000-4000-8000-000000000001")
		const result = JSON.parse(await tool.execute(report))

		expect(calls).toEqual([
			{
				orgId: "org_1",
				investigationId: "00000000-0000-4000-8000-000000000001",
				report,
			},
		])
		expect(result).toEqual({ status: DIAGNOSIS_STATUS, report })
	})
})
