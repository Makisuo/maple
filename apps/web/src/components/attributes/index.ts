// These attribute renderers now live in `@maple/ui` so the local-mode UI and
// (eventually) the native app share one implementation. This shim keeps the
// existing `@/components/attributes` import path working.
export {
	CopyableValue,
	AttributesSection,
	ResourceAttributesSection,
	tryParseJson,
} from "@maple/ui/components/attributes"
