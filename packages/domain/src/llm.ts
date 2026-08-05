import { Schema } from "effect"

/**
 * Maple's domain error for a failed model call.
 *
 * `@maple/llm` fails with its own `LLMError`, whose `reason` is a rich provider-error taxonomy
 * (transport, authentication, rate limit, quota, invalid request, content policy, provider
 * internal). This is the flattened, serializable projection Maple code matches on — it lives in
 * `@maple/domain` rather than `apps/api` so callers on either side of a Worker boundary agree on
 * the shape, and so nothing outside `apps/api/src/lib/Llm.ts` needs to import the vendored package.
 *
 * `contextOverflow` is the field with no prior equivalent anywhere in Maple: the vendored
 * `isContextOverflowFailure` recognises ~30 provider-specific phrasings of "your prompt is too
 * long". It is a genuinely different retry signal from `retryable` — retrying an overflow unchanged
 * always fails again; the transcript has to shrink first.
 */
export class LlmCallError extends Schema.TaggedErrorClass<LlmCallError>()("@maple/llm/LlmCallError", {
	/** Maple-side label for what was being attempted, e.g. `"ai-triage.investigate"`. */
	operation: Schema.String,
	/** Vendored `LLMError.module` — which part of the LLM core failed. */
	module: Schema.String,
	/** Vendored `LLMError.method`. */
	method: Schema.String,
	/** Tag of the vendored provider-error reason, e.g. `"RateLimit"`, `"InvalidRequest"`. */
	reason: Schema.String,
	message: Schema.String,
	/** The provider signalled a transient condition; retrying the same request may succeed. */
	retryable: Schema.Boolean,
	/** The request exceeded the model's context window. Retry only after shrinking the input. */
	contextOverflow: Schema.Boolean,
}) {}
