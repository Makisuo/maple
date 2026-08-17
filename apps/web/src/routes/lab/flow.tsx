import { createFileRoute } from "@tanstack/react-router"

import { FlowLab } from "@/lab/flow-lab"

export const Route = createFileRoute("/lab/flow")({ component: FlowLab })
