import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { TinybirdDateTime } from "../query-engine"
import { SessionAuthorization } from "./current-tenant"
import { warehouseReadHttpErrors } from "./warehouse"

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
	// `Schema.optional`, not `optionalKey` — matches the `ListReplaysRequest`
	// optional-payload contract for JS-constructed clients (see the note in
	// session-replay.ts and CLAUDE.md, optional vs optionalKey).
	limit: Schema.optional(Schema.Number),
	// Both filters land on the session-detection subquery, so `serviceNames`
	// means "the session-bearing spans came from this service", not "the trace
	// touched it" — see `aiSessionListQuery`.
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
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

// Exactly what a compiled warehouse read can fail with — not the wider
// `sessionReplayEndpointErrors` union, whose extra members (the legacy
// QueryEngine wrappers, token-mint errors) this endpoint can never produce.
const aiSessionEndpointErrors = warehouseReadHttpErrors

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
