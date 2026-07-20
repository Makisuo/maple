import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { InternalRpcInvalidInputError } from "@maple/domain/internal-rpc"
import { callMcpToolRpc, submitDiagnosisRpc } from "./internal-rpc"
import { InvestigationService, type InvestigationServiceShape } from "./services/InvestigationService"

const investigationId = "00000000-0000-4000-8000-000000000001"
const report = {
	summary: "Checkout latency doubled after deploy.",
	suspectedCause: "Connection pool regression",
	severityAssessment: "high",
	affectedScope: "checkout-api",
	evidence: [
		{
			traceIds: ["trace-1"],
			logPatterns: ["pool exhausted"],
			relatedServices: ["payments"],
			note: "The failing traces share the same pool exhaustion event.",
		},
	],
	suggestedActions: ["Roll back the deploy"],
	confidence: "high",
} as const

const unusedInvestigationService: InvestigationServiceShape = {
	listInvestigations: () => Effect.die("unused"),
	getInvestigation: () => Effect.die("unused"),
	createInvestigation: () => Effect.die("unused"),
	updateStatus: () => Effect.die("unused"),
	submitDiagnosis: () => Effect.die("unused"),
}

describe("internal RPC boundary", () => {
	it.effect("rejects invalid org IDs before MCP dispatch", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				callMcpToolRpc({ orgId: " ", name: "inspect_trace", input: {} }) as Effect.Effect<
					never,
					InternalRpcInvalidInputError,
					never
				>,
			)
			expect(error._tag).toBe("@maple/internal-rpc/InvalidInputError")
			expect(error.method).toBe("callMcpTool")
		}),
	)

	it.effect("rejects invalid investigation IDs and model-produced reports", () =>
		Effect.gen(function* () {
			for (const input of [
				{ orgId: "org_1", investigationId: "not-a-uuid", report },
				{ orgId: "org_1", investigationId, report: { summary: "incomplete" } },
			]) {
				const error = yield* Effect.flip(
					submitDiagnosisRpc(input).pipe(
						Effect.provideService(InvestigationService, unusedInvestigationService),
					),
				)
				expect(error._tag).toBe("@maple/internal-rpc/InvalidInputError")
				if (error._tag !== "@maple/internal-rpc/InvalidInputError") {
					throw new Error(`Expected invalid input, received ${error._tag}`)
				}
				expect(error.method).toBe("submitDiagnosis")
			}
		}),
	)

	it.effect("submits a decoded diagnosis to the org-scoped service", () =>
		Effect.gen(function* () {
			const calls: Array<{ orgId: string; investigationId: string; summary: string }> = []
			const expected = { id: investigationId, status: "diagnosed" } as never
			const service: InvestigationServiceShape = {
				...unusedInvestigationService,
				submitDiagnosis: (orgId, id, request) =>
					Effect.sync(() => {
						calls.push({ orgId, investigationId: id, summary: request.report.summary })
						return expected
					}),
			}

			const result = yield* submitDiagnosisRpc({ orgId: "org_1", investigationId, report }).pipe(
				Effect.provideService(InvestigationService, service),
			)
			expect(result).toBe(expected)
			expect(calls).toEqual([
				{ orgId: "org_1", investigationId, summary: "Checkout latency doubled after deploy." },
			])
		}),
	)
})
