import { createFileRoute } from "@tanstack/react-router"

import { TimelineLab } from "@/lab/timeline-lab"

export const Route = createFileRoute("/lab/timeline")({ component: TimelineLab })
