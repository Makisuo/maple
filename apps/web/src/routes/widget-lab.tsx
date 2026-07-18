import { createFileRoute } from "@tanstack/react-router"

import { WidgetLab } from "@/components/widget-lab/widget-lab"

export const Route = createFileRoute("/widget-lab")({
	component: WidgetLab,
})
