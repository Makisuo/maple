// AI agent sessions — the warehouse queries that resolve sessions and their
// spans from the `maple_ai.*` attributes the ingest gateway stamps at decode
// time, plus the integration layer that maps each raw span onto Maple's
// standardised AI agent span format.
//
// The span shape itself — the `AI_GENAI_FIELDS` catalog and the schema
// generated from it — lives in `@maple/domain/gen-ai`, so the wire contract and
// the decoder read one list.

export {
	aiSessionFacetsQuery,
	aiSessionListQuery,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	aiSessionSummaryQuery,
	aiSessionSummaryRowSchema,
	aiSessionTotalsQuery,
	aiSessionTotalsRowSchema,
	aiSessionWindowQuery,
	aiTraceSpansQuery,
	aiTraceSummaryQuery,
	aiTraceTotalsQuery,
	aiTraceWindowQuery,
	type AiSessionFacetsOutput,
	type AiSessionListOpts,
	type AiSessionListOutput,
	type AiSessionSpansOpts,
	type AiSessionSpansOutput,
	type AiSessionSummaryOutput,
	type AiSessionTotalsOutput,
	type AiSessionWindowOutput,
} from "./ai-sessions"

export {
	aiFieldSourceKeys,
	aiSpanAttributeKeys,
	genAiIntegration,
	mapAiSpan,
	mapAiSpans,
	resolveAiIntegration,
	type AiIntegration,
	type AiRefineContext,
} from "./ai-integrations"
