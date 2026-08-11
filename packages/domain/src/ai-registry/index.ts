// Subpath barrel: `@maple/domain/ai-registry`.
//
// Deliberately NOT re-exported from the root `@maple/domain` barrel. `registry.json` is ~280 KB of
// vendored data, and web/cli import the root barrel — everything here is pure data plus string
// building, so it is safe to import anywhere, but nobody should pay for it implicitly.

export {
	AI_SESSION_KEY_STATE,
	AI_SESSION_KEY_STATE_ELIGIBLE,
	AiRegistryDocument,
	AuthorityPredicate,
	Matcher,
	MatcherClass,
	MatcherSignal,
	PREDICATE_OPS,
	PSEUDO_KEYS,
	Predicate,
	PseudoKeySchema,
	SessionCandidate,
	SessionGranularity,
	UnknownTierRule,
	ValidationToken,
	Vendor,
	aiRegistry,
	aiRegistryVendorsBySlug,
	type AiSessionKeyState,
	type Caveat,
	type DecoyKey,
	type DecoyValue,
	type PseudoKey,
	type Variant,
} from "./schema"

export {
	PRIORITY_BANDS,
	UNKNOWN_VENDOR_PREFIX,
	formatRegistryViolations,
	validateRegistry,
	type RegistryViolation,
	type RegistryViolationCode,
} from "./validate"

export {
	AI_REGISTRY_RULES_VERSION_ALIAS,
	AI_REGISTRY_SESSION_KEY_VALUE_ALIAS,
	DEFAULT_AI_REGISTRY_SQL_COLUMNS,
	compileAiRegistrySql,
	compilePredicateSql,
	quoteSqlString,
	renderAiRegistrySelect,
	type AiRegistrySqlColumns,
	type CompileAiRegistrySqlOptions,
	type CompiledAiRegistrySql,
	type RenderAiRegistrySelectOptions,
} from "./compile-sql"
