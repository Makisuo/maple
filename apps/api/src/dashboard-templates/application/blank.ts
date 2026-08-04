import { buildPortableDashboard, templateId } from "@/dashboard-templates/helpers"
import type { TemplateDefinition } from "@/dashboard-templates/types"

export const blankTemplate: TemplateDefinition = {
	id: templateId("blank"),
	name: "Blank Dashboard",
	description: "Start from an empty dashboard and add widgets manually.",
	category: "application",
	tags: [],
	parameters: [],
	build: () =>
		buildPortableDashboard({
			name: "Untitled Dashboard",
			widgets: [],
		}),
}
