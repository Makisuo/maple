// Subpath barrel: `@maple/domain/ai`.
//
// The read path's view of AI span classification. Vendor knowledge itself is Rust
// (`apps/ingest/src/ai_vendors.rs`); nothing here re-implements a rule. This is the
// slug vocabulary the `AiVendor` column speaks, plus the rollup's reader contract.
//
// Deliberately NOT re-exported from the root `@maple/domain` barrel — it is a leaf
// concern and the root barrel is imported by web and cli.

export { AI_VENDORS, AI_VENDOR_LABELS, type AiVendor } from "./vendors"

export {
	normalizeAiSpan,
	type AiSpanFacts,
	type AiSpanInput,
	type AiSpanRole,
} from "./integrations"

export { AI_VENDORS_ROLLUP_ENABLEMENT_HOUR_ENV, AI_VENDORS_ROLLUP_TABLE } from "./rollup-enablement"
