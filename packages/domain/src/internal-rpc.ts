import type * as Effect from "effect/Effect"
import { Schema } from "effect"
import type {
	InvestigationDocument,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
} from "./http/investigations"
import { AiTriageResult } from "./http/ai-triage"
import { InvestigationId, OrgId } from "./primitives"

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed()))

/** Runtime-validated arguments for an internal MCP tool call. */
export class CallMcpToolRpcRequest extends Schema.Class<CallMcpToolRpcRequest>("CallMcpToolRpcRequest")({
	orgId: OrgId,
	name: NonEmptyString,
	input: Schema.Unknown,
}) {}

/** Runtime-validated structured diagnosis submitted by chat-flue. */
export class SubmitDiagnosisRpcRequest extends Schema.Class<SubmitDiagnosisRpcRequest>(
	"SubmitDiagnosisRpcRequest",
)({
	orgId: OrgId,
	investigationId: InvestigationId,
	report: AiTriageResult,
}) {}

export interface InternalMcpToolDescriptor {
	readonly name: string
	readonly description: string
	readonly inputSchema: Record<string, unknown>
}

export interface InternalMcpToolResult {
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
	readonly isError?: boolean
}

export class InternalRpcInvalidInputError extends Schema.TaggedErrorClass<InternalRpcInvalidInputError>()(
	"@maple/internal-rpc/InvalidInputError",
	{
		method: Schema.Literals(["callMcpTool", "submitDiagnosis"]),
		message: Schema.String,
	},
) {}

export class InternalRpcToolNotFoundError extends Schema.TaggedErrorClass<InternalRpcToolNotFoundError>()(
	"@maple/internal-rpc/ToolNotFoundError",
	{
		name: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Alchemy schemaless RPC shape exposed by the Maple API Worker.
 *
 * The method parameters intentionally remain `unknown`: Cloudflare RPC does
 * structured cloning, not validation, so the implementation must decode each
 * request with the schemas above before using it.
 */
export interface MapleApiRpcShape {
	readonly listMcpTools: () => Effect.Effect<ReadonlyArray<InternalMcpToolDescriptor>>
	readonly callMcpTool: (
		request: unknown,
	) => Effect.Effect<InternalMcpToolResult, InternalRpcInvalidInputError | InternalRpcToolNotFoundError>
	readonly submitDiagnosis: (
		request: unknown,
	) => Effect.Effect<
		InvestigationDocument,
		InternalRpcInvalidInputError | InvestigationNotFoundError | InvestigationPersistenceError
	>
}
