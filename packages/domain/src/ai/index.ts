// Subpath barrel: `@maple/domain/ai`.
//
// The read path's view of AI span classification. Vendor knowledge itself is Rust
// (`apps/ingest/src/ai_vendors.rs`); nothing here re-implements a rule. This is the
// slug vocabulary the `AiVendor` column speaks.
//
// Deliberately NOT re-exported from the root `@maple/domain` barrel — it is a leaf
// concern and the root barrel is imported by web and cli.

export { AI_VENDORS, AI_VENDOR_LABELS, type AiVendor } from "./vendors"
