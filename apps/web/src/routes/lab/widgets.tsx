import { createFileRoute } from "@tanstack/react-router"

import { WidgetLab } from "@/lab/widget-lab/widget-lab"

export const Route = createFileRoute("/lab/widgets")({
	component: WidgetLab,
})
