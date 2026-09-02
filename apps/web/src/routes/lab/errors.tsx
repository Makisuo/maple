import { createFileRoute } from "@tanstack/react-router"

import { ErrorsLab } from "@/lab/errors-lab"

export const Route = createFileRoute("/lab/errors")({ component: ErrorsLab })
