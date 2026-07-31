/**
 * Safe `{{ variable }}` template renderer for alert notifications.
 *
 * Deliberately NOT a general template engine: there is no code execution, no
 * arbitrary property access, no `eval`/`Function`. A template is scanned for a
 * tiny fixed grammar and substituted against a flat, pre-computed string map:
 *
 *   - `{{ key }}`                     → context[key] (empty string if missing)
 *   - `{{ key | default:"fallback" }}`→ context[key], or "fallback" when missing/empty
 *   - `{{#if key}}...{{/if}}`         → inner content when context[key] is non-empty
 *
 * `#if` blocks must not be nested. Every function here is total — a malformed
 * template never throws; it degrades to literal text and reports missing keys.
 * Keys are `[A-Za-z0-9_.]+` (e.g. `rule.name`, `links.app`).
 */

interface NotificationTemplateOverride {
	readonly title?: string | null
	readonly body?: string | null
}

/**
 * Raw, user-supplied template config as stored on the rule / snapshotted into a
 * delivery payload. `overrides` is keyed by destination type
 * (`slack`/`discord`/…); unset fields fall back override → top-level → default.
 */
export interface NotificationTemplateConfig {
	readonly title?: string | null
	readonly body?: string | null
	readonly overrides?: { readonly [destinationType: string]: NotificationTemplateOverride } | null
}

/** A template resolved for one destination. `null` means "use the built-in default". */
export interface ResolvedTemplate {
	readonly title: string | null
	readonly body: string | null
}

export interface RenderResult {
	readonly text: string
	/** Sorted, de-duplicated list of `{{ keys }}` that had no value (and no default). */
	readonly missing: ReadonlyArray<string>
}

export type TemplateContext = Readonly<Record<string, string>>

const IF_BLOCK = /\{\{\s*#if\s+([A-Za-z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g
const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|\s*default\s*:\s*"([^"]*)"\s*)?\}\}/g

const isPresent = (value: string | undefined): value is string => value != null && value !== ""

/**
 * Render `template` against `context`. Total: never throws. Unknown/empty
 * variables render as "" (or their `default:`), and are collected in `missing`.
 */
export const renderTemplate = (template: string, context: TemplateContext): RenderResult => {
	const missing = new Set<string>()

	// 1. Resolve conditional blocks first; their inner tokens are substituted in step 2.
	const withConditionals = template.replace(IF_BLOCK, (_match, key: string, inner: string) =>
		isPresent(context[key]) ? inner : "",
	)

	// 2. Substitute remaining tokens.
	const text = withConditionals.replace(TOKEN, (_match, key: string, fallback: string | undefined) => {
		const value = context[key]
		if (isPresent(value)) return value
		if (fallback !== undefined) return fallback
		missing.add(key)
		return ""
	})

	return { text, missing: [...missing].sort() }
}

const firstNonEmpty = (...values: ReadonlyArray<string | null | undefined>): string | null => {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value
	}
	return null
}

/**
 * Resolve the effective `{ title, body }` template strings for one destination
 * type, applying override → top-level → `null` (built-in default) per field.
 */
export const resolveTemplate = (
	config: NotificationTemplateConfig | null | undefined,
	destinationType: string,
	legacyDestinationTypes: ReadonlyArray<string> = [],
): ResolvedTemplate => {
	if (config == null) return { title: null, body: null }
	const overrides = [destinationType, ...legacyDestinationTypes].map(
		(type) => config.overrides?.[type],
	)
	return {
		title: firstNonEmpty(...overrides.map((override) => override?.title), config.title),
		body: firstNonEmpty(...overrides.map((override) => override?.body), config.body),
	}
}

/** True when a resolved template provides at least one custom field. */
export const hasCustomTemplate = (resolved: ResolvedTemplate): boolean =>
	resolved.title != null || resolved.body != null
