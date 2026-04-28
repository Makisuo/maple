import { useMemo, useState } from "react"
import type { DashboardTemplateMetadata } from "@maple/domain/http"
import { TemplateCard } from "./template-card"
import { ParameterDialog, type TemplateParameterField } from "./parameter-dialog"

const CATEGORY_LABELS: Record<string, string> = {
	application: "Application",
	database: "Databases",
	infrastructure: "Infrastructure",
	messaging: "Messaging",
}

const CATEGORY_ORDER = ["application", "database", "infrastructure", "messaging"] as const

interface TemplatePickerProps {
	templates: ReadonlyArray<DashboardTemplateMetadata>
	disabled?: boolean
	submitting: boolean
	onUse: (templateId: string, parameters: Record<string, string>) => void
}

export function TemplatePicker({ templates, disabled = false, submitting, onUse }: TemplatePickerProps) {
	const [pendingTemplate, setPendingTemplate] = useState<DashboardTemplateMetadata | null>(null)

	const grouped = useMemo(() => {
		const byCategory = new Map<string, DashboardTemplateMetadata[]>()
		for (const t of templates) {
			const list = byCategory.get(t.category) ?? []
			list.push(t)
			byCategory.set(t.category, list)
		}
		return CATEGORY_ORDER.map((cat) => ({
			category: cat,
			templates: byCategory.get(cat) ?? [],
		})).filter((g) => g.templates.length > 0)
	}, [templates])

	const handleUse = (template: DashboardTemplateMetadata) => {
		if (template.parameters.length === 0) {
			onUse(template.id, {})
			return
		}
		setPendingTemplate(template)
	}

	const dialogParameters: TemplateParameterField[] = useMemo(
		() =>
			pendingTemplate?.parameters.map((p) => ({
				key: p.key,
				label: p.label,
				description: p.description,
				required: p.required,
				placeholder: p.placeholder,
			})) ?? [],
		[pendingTemplate],
	)

	return (
		<>
			<div className="flex flex-col gap-8">
				{grouped.map(({ category, templates: list }) => (
					<section key={category} className="flex flex-col gap-3">
						<h3 className="text-xs font-medium text-dim uppercase tracking-wider">
							{CATEGORY_LABELS[category] ?? category}
						</h3>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
							{list.map((template) => (
								<TemplateCard
									key={template.id}
									id={template.id}
									name={template.name}
									description={template.description}
									tags={template.tags}
									requirements={template.requirements}
									disabled={disabled || submitting}
									onUse={() => handleUse(template)}
								/>
							))}
						</div>
					</section>
				))}
			</div>

			<ParameterDialog
				open={pendingTemplate !== null}
				templateName={pendingTemplate?.name ?? ""}
				parameters={dialogParameters}
				submitting={submitting}
				onCancel={() => setPendingTemplate(null)}
				onSubmit={(values) => {
					if (!pendingTemplate) return
					onUse(pendingTemplate.id, values)
					setPendingTemplate(null)
				}}
			/>
		</>
	)
}
