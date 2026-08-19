import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { TinybirdDateTime } from "../query-engine"
import { SessionAuthorization } from "./current-tenant"
import { QueryEngineExecutionError, QueryEngineTimeoutError } from "./query-engine"
import { warehouseHttpErrors } from "./warehouse"

// AI agent session endpoint schemas
//
// Backed by the `maple_ai.*` span attributes the ingest gateway stamps at
// decode time; a session is resolved at trace granularity by
// `aiSessionListQuery` in the query-engine integrations layer. The Agent
// Sessions page is behind the `agent_tracing` org rollout flag and these
// shapes exist for it alone, so they live in the internal tier where they can
// follow the UI.

export class ListAiSessionsRequest extends Schema.Class<ListAiSessionsRequest>("ListAiSessionsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// `Schema.optional`, not `optionalKey`: the web client constructs the payload
	// JS-side and passes explicit `undefined` for an unset field. See the note in
	// session-replay.ts (and CLAUDE.md, optional vs optionalKey).
	limit: Schema.optional(Schema.Number),
}) {}

export const AiSessionListItem = Schema.Struct({
	sessionId: Schema.String,
	/** Vendor of the earliest session-bearing span, e.g. `eve`, `vercel_ai_sdk`. */
	vendorId: Schema.String,
	vendorVersion: Schema.String,
	traceCount: Schema.Number,
	/** All spans of all the session's traces, including non-AI infrastructure spans. */
	spanCount: Schema.Number,
	errorSpanCount: Schema.Number,
	/** Every service touched by the session's traces. */
	serviceNames: Schema.Array(Schema.String),
	/** Warehouse datetime literals, e.g. `2026-08-19 10:33:25.825000000`. */
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
})

export class ListAiSessionsResponse extends Schema.Class<ListAiSessionsResponse>("ListAiSessionsResponse")({
	data: Schema.Array(AiSessionListItem),
}) {}

const aiSessionEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

export class AiSessionsInternalApiGroup extends HttpApiGroup.make("aiSessionsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: ListAiSessionsRequest,
			success: ListAiSessionsResponse,
			error: aiSessionEndpointErrors,
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
