import {
	CallMcpToolRpcRequest,
	InternalRpcInvalidInputError,
	SubmitDiagnosisRpcRequest,
} from "@maple/domain/internal-rpc"
import { SubmitDiagnosisRequest } from "@maple/domain/http"
import { UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import type { TenantContext } from "./lib/tenant-context"
import { callMcpTool, listMcpTools } from "./mcp/dispatcher"
import { CurrentMcpTenant } from "./mcp/lib/query-warehouse"
import { InvestigationService } from "./services/InvestigationService"

const internalServiceUserId = Schema.decodeUnknownSync(UserId)("internal-service")

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
			callMcpTool(request.name, request.input).pipe(
				Effect.provideService(CurrentMcpTenant, makeInternalTenant(request.orgId)),
			),
		),
		Effect.withSpan("InternalRpc.callMcpTool"),
	)

export const submitDiagnosisRpc = (input: unknown) =>
	Effect.gen(function* () {
		const request = yield* decodeSubmitDiagnosis(input)
		yield* Effect.annotateCurrentSpan({
			"maple.org_id": request.orgId,
			"maple.investigation.id": request.investigationId,
		})
		const investigations = yield* InvestigationService
		return yield* investigations.submitDiagnosis(
			request.orgId,
			request.investigationId,
			new SubmitDiagnosisRequest({ report: request.report }),
		)
	}).pipe(Effect.withSpan("InternalRpc.submitDiagnosis"))
