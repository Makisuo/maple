import {
	CallMcpToolRpcRequest,
	InternalRpcInvalidInputError,
	SubmitDiagnosisRpcRequest,
} from "@maple/domain/internal-rpc"
import { SubmitDiagnosisRequest } from "@maple/domain/http"
import { UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import type { TenantContext } from "@/services/auth/tenant-context"
import { McpToolExecutor, listMcpTools } from "./mcp/dispatcher"
import { InvestigationService } from "./services/errors/InvestigationService"

const internalServiceUserId = Schema.decodeSync(UserId)("internal-service")

const invalidInput = (method: "callMcpTool" | "submitDiagnosis") => (error: { message: string }) =>
	new InternalRpcInvalidInputError({ method, message: error.message })

const decodeCallMcpTool = (input: unknown) =>
	Schema.decodeUnknownEffect(CallMcpToolRpcRequest)(input).pipe(
		Effect.mapError(invalidInput("callMcpTool")),
	)

const decodeSubmitDiagnosis = (input: unknown) =>
	Schema.decodeUnknownEffect(SubmitDiagnosisRpcRequest)(input).pipe(
		Effect.mapError(invalidInput("submitDiagnosis")),
	)

const makeInternalTenant = (orgId: CallMcpToolRpcRequest["orgId"]): TenantContext => ({
	orgId,
	userId: internalServiceUserId,
	roles: [],
	authMode: "self_hosted",
})

export const listMcpToolsRpc = listMcpTools.pipe(Effect.withSpan("InternalRpc.listMcpTools"))

export const callMcpToolRpc = (input: unknown) =>
	decodeCallMcpTool(input).pipe(
		Effect.flatMap((request) =>
			McpToolExecutor.pipe(
				Effect.flatMap((executor) =>
					executor.execute(makeInternalTenant(request.orgId), request.name, request.input),
				),
			),
		),
		Effect.withSpan("InternalRpc.callMcpTool"),
	)

export const submitDiagnosisRpc = Effect.fn("InternalRpc.submitDiagnosis")(function* (input: unknown) {
	const request = yield* decodeSubmitDiagnosis(input)
	yield* Effect.annotateCurrentSpan({
		orgId: request.orgId,
		"maple.investigation.id": request.investigationId,
	})
	const investigations = yield* InvestigationService
	return yield* investigations.submitDiagnosis(
		request.orgId,
		request.investigationId,
		new SubmitDiagnosisRequest({ report: request.report }),
	)
})
