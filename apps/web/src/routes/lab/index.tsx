import { createFileRoute } from "@tanstack/react-router"

import { LabIndex } from "@/lab/lab-index"

export const Route = createFileRoute("/lab/")({ component: LabIndex })
