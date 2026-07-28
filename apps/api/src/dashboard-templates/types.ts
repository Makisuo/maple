import type {
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardTemplatePreviewKind,
	PortableDashboardDocument,
} from "@maple/domain/http"

export type WidgetDef = {
	id: string
	visualization: string
	dataSource: {
		endpoint: string
		params?: Record<string, unknown>
		transform?: Record<string, unknown>
	}
	display: Record<string, unknown>
	layout: { x: number; y: number; w: number; h: number }
}

interface TemplateParameter {
	key: DashboardTemplateParameterKey
	label: string
	description: string
	required: boolean
	placeholder?: string
}

export type TemplateParameterValues = Partial<Record<DashboardTemplateParameterKey, string>>

export interface TemplateDefinition {
	id: DashboardTemplateId
	name: string
	description: string
	category: DashboardTemplateCategory
	tags: readonly string[]
	requirements: readonly string[]
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
	requirements: readonly string[]
	requiredMetricPrefixes: readonly string[]
	parameters: readonly TemplateParameter[]
	preview: readonly TemplatePreviewWidget[]
}
