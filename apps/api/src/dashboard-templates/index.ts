import type { DashboardTemplateId, DashboardTemplatePreviewKind } from "@maple/domain/http"
import { blankTemplate } from "./application/blank"
import { errorTrackingTemplate } from "./application/error-tracking"
import { grpcServiceTemplate } from "./application/grpc-service"
import { httpEndpointsTemplate } from "./application/http-endpoints"
import { jvmRuntimeTemplate } from "./application/jvm-runtime"
import { metricOverviewTemplate } from "./application/metric-overview"
import { nodejsRuntimeTemplate } from "./application/nodejs-runtime"
import { platformOverviewTemplate } from "./application/platform-overview"
import { serviceHealthTemplate } from "./application/service-health"
import { topErrorsTemplate } from "./application/top-errors"
import { mongodbTemplate } from "./database/mongodb"
import { mysqlTemplate } from "./database/mysql"
import { postgresTemplate } from "./database/postgres"
import { redisTemplate } from "./database/redis"
import { cloudflareTemplate } from "./infrastructure/cloudflare"
import { planetscaleTemplate } from "./infrastructure/planetscale"
import { hostMetricsTemplate } from "./infrastructure/host-metrics"
import { kubernetesClusterTemplate } from "./infrastructure/kubernetes-cluster"
import { kubernetesPodTemplate } from "./infrastructure/kubernetes-pod"
import { kafkaTemplate } from "./messaging/kafka"
import { natsTemplate } from "./messaging/nats"
import { rabbitmqTemplate } from "./messaging/rabbitmq"
import type { TemplateDefinition, TemplateMetadata, TemplatePreviewWidget } from "./types"

export const DASHBOARD_TEMPLATES: ReadonlyArray<TemplateDefinition> = [
	// Application
	serviceHealthTemplate,
	errorTrackingTemplate,
	platformOverviewTemplate,
	httpEndpointsTemplate,
	topErrorsTemplate,
	metricOverviewTemplate,
	jvmRuntimeTemplate,
	nodejsRuntimeTemplate,
	grpcServiceTemplate,
	blankTemplate,
	// Database
	postgresTemplate,
	mongodbTemplate,
	redisTemplate,
	mysqlTemplate,
	// Infrastructure
	cloudflareTemplate,
	planetscaleTemplate,
	hostMetricsTemplate,
	kubernetesClusterTemplate,
	kubernetesPodTemplate,
	// Messaging
	kafkaTemplate,
	natsTemplate,
	rabbitmqTemplate,
]

const TEMPLATE_BY_ID = new Map<string, TemplateDefinition>(DASHBOARD_TEMPLATES.map((t) => [t.id, t]))

export function getTemplate(id: string): TemplateDefinition | undefined {
	return TEMPLATE_BY_ID.get(id)
}

export function getTemplateById(id: DashboardTemplateId): TemplateDefinition | undefined {
	return TEMPLATE_BY_ID.get(id)
}

function previewKindForWidget(visualization: string, chartId: unknown): DashboardTemplatePreviewKind {
	switch (visualization) {
		case "chart": {
			if (typeof chartId === "string") {
				if (chartId.endsWith("-area")) return "area"
				if (chartId.endsWith("-bar")) return "bar"
			}
			return "line"
		}
		case "stat":
			return "stat"
		case "list":
			return "list"
		default:
			return "table"
	}
}

export function buildTemplatePreview(template: TemplateDefinition): TemplatePreviewWidget[] {
	return template.build({}).widgets.map((w) => ({
		x: w.layout.x,
		y: w.layout.y,
		w: w.layout.w,
		h: w.layout.h,
		kind: previewKindForWidget(w.visualization, w.display.chartId),
		title: w.display.title ?? "",
	}))
}

// Previews are derived from the (pure, deterministic) template builds; compute once.
const TEMPLATE_PREVIEWS = new Map<string, TemplatePreviewWidget[]>(
	DASHBOARD_TEMPLATES.map((t) => [t.id, buildTemplatePreview(t)]),
)

export function listTemplateMetadata(): TemplateMetadata[] {
	return DASHBOARD_TEMPLATES.map((t) => ({
		id: t.id,
		name: t.name,
		description: t.description,
		category: t.category,
		tags: t.tags,
		requirements: t.requirements,
		requiredMetricPrefixes: t.requiredMetricPrefixes ?? [],
		parameters: t.parameters,
		preview: TEMPLATE_PREVIEWS.get(t.id) ?? [],
	}))
}

export type {
	TemplateDefinition,
	TemplateMetadata,
	TemplateParameterValues,
	TemplatePreviewWidget,
	WidgetDef,
} from "./types"
