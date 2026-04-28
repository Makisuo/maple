import { buildPortableDashboard, templateId } from "../helpers"
import type { TemplateDefinition } from "../types"

export const blankTemplate: TemplateDefinition = {
	id: templateId("blank"),
	name: "Blank Dashboard",
	description: "Start from an empty dashboard and add widgets manually.",
	category: "application",
	tags: [],
	requirements: [],
	parameters: [],
	build: () =>
		buildPortableDashboard({
			name: "Untitled Dashboard",
			widgets: [],
		}),
}
