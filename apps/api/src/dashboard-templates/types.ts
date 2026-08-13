import type {
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardTemplatePreviewKind,
	DashboardWidgetSchema,
	PortableDashboardDocument,
} from "@maple/domain/http"

/**
 * A template widget is just a widget.
 *
 * This used to be a hand-written structural shape with `visualization: string`
 * and `display: Record<string, unknown>`, so a template could misspell a display
 * key or name a visualization that does not exist and only fail at runtime, in
 * `decodePortableDashboard`. Aliasing the real schema type moves all 22 template
 * files onto the compiler.
 *
 * `layout` needs no widening: `WidgetLayoutSchema` already makes `minW`/`minH`
 * optional, which is what templates omit.
 */
export type WidgetDef = typeof DashboardWidgetSchema.Type

interface TemplateParameter {
	key: DashboardTemplateParameterKey
	label: string
	description: string
	required: boolean
	placeholder?: string
}

export type TemplateParameterValues = Partial<Record<DashboardTemplateParameterKey, string>>

/**
 * What an org needs before this template's widgets have anything to draw.
 *
 * The picker states this twice at different lengths: a row-sized `missing`
 * ("no kafka.*") next to the template name, and the `collector` that emits the
 * data in the detail panel. Structured rather than prose so neither has to be
 * recovered by string-matching in the web app.
 */
export interface TemplateRequirement {
	/**
	 * `metrics` gates on `requiredMetricPrefixes`; `integration` on a connected
	 * integration; `telemetry` is never gated (trace/log templates).
	 */
	readonly kind: "metrics" | "integration" | "telemetry"
	/** Full prose, surfaced as the public `requirements[]` field. */
	readonly label: string
	/**
	 * Row-sized statement of what's missing, e.g. "not connected". Omit for
	 * `kind: "metrics"` — the picker derives `no <prefix>*` from
	 * `requiredMetricPrefixes`.
	 */
	readonly missing?: string
	/**
	 * Noun phrase naming what emits the data, read as "Collected by {collector}."
	 * — "the OpenTelemetry kafkametricsreceiver".
	 */
	readonly collector: string
	/**
	 * Short noun phrase for the gated call to action, read as "Set up
	 * {setupLabel}" — "the Kafka receiver". Unused for `kind: "telemetry"`,
	 * which is never gated.
	 */
	readonly setupLabel?: string
	/** One extra sentence shown under the collector when the template is gated. */
	readonly hint?: string
}

export interface TemplateDefinition {
	id: DashboardTemplateId
	name: string
	description: string
	category: DashboardTemplateCategory
	tags: readonly string[]
	/** Absent only for the blank template, which needs nothing. */
	requirement?: TemplateRequirement
	/**
	 * Metric-name prefixes this template's widgets query. The template picker
	 * greys out a template when the org has no metric matching every prefix —
	 * a metrics-only template renders entirely empty without them. Empty/absent
	 * means the template is never gated (trace/log templates).
	 */
	requiredMetricPrefixes?: readonly string[]
	parameters: readonly TemplateParameter[]
	build: (params: TemplateParameterValues) => PortableDashboardDocument
}

export interface TemplatePreviewWidget {
	x: number
	y: number
	w: number
	h: number
	kind: DashboardTemplatePreviewKind
	title: string
}

export interface TemplateMetadata {
	id: DashboardTemplateId
	name: string
	description: string
	category: DashboardTemplateCategory
	tags: readonly string[]
	/** Derived from `requirement.label`; kept for the public wire. */
	requirements: readonly string[]
	requirement: TemplateRequirement | null
	requiredMetricPrefixes: readonly string[]
	parameters: readonly TemplateParameter[]
	preview: readonly TemplatePreviewWidget[]
}
