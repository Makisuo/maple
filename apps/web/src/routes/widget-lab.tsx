import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"

import { WidgetLab } from "@/components/widget-lab/widget-lab"

export const Route = effectRoute(createFileRoute("/widget-lab"))({
	component: WidgetLab,
})
