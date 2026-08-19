// AI agent sessions — the warehouse queries that resolve sessions and their
// spans from the `maple_ai.*` attributes the ingest gateway stamps at decode
// time, plus the integration layer that maps each raw span onto Maple's
// standardised AI agent span format.
//
// The two halves compose: `aiSessionSpansQuery` rows structurally satisfy
// `AiSessionSpanRow`, so `mapAiSpans(rows)` is the whole read path.

export {
	aiSessionListQuery,
	aiSessionListRowSchema,
	AI_SESSION_SPANS_MAX_SPANS,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	type AiSessionListOpts,
	type AiSessionListOutput,
	type AiSessionSpansOpts,
	type AiSessionSpansOutput,
} from "./ai-sessions"

export {
	AI_GENAI_FIELDS,
	AI_KNOWN_OPERATION_NAMES,
	AI_PROMPT_VARIABLE_PREFIX,
	AiAgentSpanSchema,
	AiGenAiValuesSchema,
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
	type AiAgentSpan,
	type AiFieldDef,
	type AiFieldGroup,
	type AiFieldValue,
	type AiGenAiField,
	type AiGenAiValues,
	type AiKnownOperationName,
	type AiSessionSpanRow,
	type MutableAiGenAiValues,
} from "./ai-span-model"

export {
	genAiIntegration,
	mapAiSpan,
	mapAiSpans,
	resolveAiIntegration,
	type AiDecodedValue,
	type AiIntegration,
	type AiJsonValue,
	type AiRefineContext,
} from "./ai-integrations"

export { AI_VENDOR_INTEGRATIONS, type AiVendorRegistry } from "./ai-vendors"

// The two halves above are joined by structure alone — the query module and the
// span model each declare the row shape independently, and nothing imports the
// other. This assertion is what makes the "structurally satisfy" claim in the
// header enforceable: add a column to the query, retype one, or drop one, and
// the read path fails to compile here rather than quietly mapping fewer fields
// in production.
import type { AiSessionSpansOutput } from "./ai-sessions"
import type { AiSessionSpanRow } from "./ai-span-model"

type Assert<T extends true> = T
// Mutual, not one-directional: `extends` alone would accept a query that grew a
// column the mapper never sees, which is exactly the drift worth catching.
type _QueryRowSatisfiesMapperInput = Assert<
	AiSessionSpansOutput extends AiSessionSpanRow
		? AiSessionSpanRow extends AiSessionSpansOutput
			? true
			: false
		: false
>
