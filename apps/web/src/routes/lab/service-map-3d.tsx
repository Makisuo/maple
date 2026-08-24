import { createFileRoute } from "@tanstack/react-router"

import { ServiceMap3DLab } from "@/lab/service-map-3d"

export const Route = createFileRoute("/lab/service-map-3d")({ component: ServiceMap3DLab })
