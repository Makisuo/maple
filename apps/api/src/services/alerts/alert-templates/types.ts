import type { AlertRuleUpsertRequest } from "@maple/domain/http"

/**
 * Ready-made alert rules for signals an integration knows about but a generic
 * rule builder can't suggest.
 *
 * These are templates over the EXISTING rule machinery, deliberately not a new
 * signal type. `builder_query` compiles through the same path as a dashboard
 * chart and `raw_query` covers everything expressible as ClickHouse SQL, so a
 * new signal type would mean new evaluation, new state keying, new incident
 * rendering and a new public contract — for zero new capability.
 *
 * Applying a template goes through the normal AlertsService upsert, so
 * name-uniqueness, compile validation and the txid response come for free.
 */

export interface AlertTemplateParameter {
	readonly key: string
	readonly label: string
	readonly description: string
	readonly required: boolean
	/** Absent for free-text; present for numeric thresholds the operator must pick. */
	readonly defaultValue?: string
	readonly placeholder?: string
}

export interface AlertTemplateRequirement {
	/** What must be connected. Shown next to the template name when it isn't. */
	readonly kind: "integration"
	readonly integrationId: string
	readonly label: string
	/** Row-sized reason the template is unavailable, e.g. "PlanetScale not connected". */
	readonly missing: string
}

export interface AlertTemplateDefinition {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly category: "infrastructure"
	readonly tags: ReadonlyArray<string>
	readonly requirement: AlertTemplateRequirement
	/**
	 * Metric-name prefixes the org must already be ingesting. The UI greys the
	 * template out rather than letting someone create a rule that can only ever
	 * report no-data.
	 */
	readonly requiredMetricPrefixes: ReadonlyArray<string>
	readonly parameters: ReadonlyArray<AlertTemplateParameter>
	/**
	 * Returns an ARRAY because one operator intent can need several rules: the
	 * MySQL and Postgres products expose replication lag under different metric
	 * names, and a "replica lag" alert has to cover both.
	 */
	readonly build: (params: {
		readonly values: Readonly<Record<string, string>>
		readonly destinationIds: ReadonlyArray<string>
		readonly enabled: boolean
	}) => ReadonlyArray<AlertRuleUpsertRequest>
}

/**
 * Tag that records which template produced a rule, so "already applied" needs no
 * new column. Rule tags are capped at 32 characters, which is why template ids
 * are short (`ps-storage-runway`) while their user-facing `name` is not.
 */
export const templateTag = (templateId: string) => `template:${templateId}`
