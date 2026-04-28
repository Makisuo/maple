import type {
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
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

export interface TemplateParameter {
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
	parameters: readonly TemplateParameter[]
	build: (params: TemplateParameterValues) => PortableDashboardDocument
}

export interface TemplateMetadata {
	id: DashboardTemplateId
	name: string
	description: string
	category: DashboardTemplateCategory
	tags: readonly string[]
	requirements: readonly string[]
	parameters: readonly TemplateParameter[]
}
