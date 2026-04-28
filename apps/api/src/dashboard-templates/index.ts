import type { DashboardTemplateId } from "@maple/domain/http"
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
import { hostMetricsTemplate } from "./infrastructure/host-metrics"
import { kubernetesClusterTemplate } from "./infrastructure/kubernetes-cluster"
import { kubernetesPodTemplate } from "./infrastructure/kubernetes-pod"
import { kafkaTemplate } from "./messaging/kafka"
import { natsTemplate } from "./messaging/nats"
import { rabbitmqTemplate } from "./messaging/rabbitmq"
import type { TemplateDefinition, TemplateMetadata } from "./types"

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
	hostMetricsTemplate,
	kubernetesClusterTemplate,
	kubernetesPodTemplate,
	// Messaging
	kafkaTemplate,
	natsTemplate,
	rabbitmqTemplate,
]

const TEMPLATE_BY_ID = new Map<string, TemplateDefinition>(
	DASHBOARD_TEMPLATES.map((t) => [t.id, t]),
)

export function getTemplate(id: string): TemplateDefinition | undefined {
	return TEMPLATE_BY_ID.get(id)
}

export function getTemplateById(id: DashboardTemplateId): TemplateDefinition | undefined {
	return TEMPLATE_BY_ID.get(id)
}

export function listTemplateMetadata(): TemplateMetadata[] {
	return DASHBOARD_TEMPLATES.map((t) => ({
		id: t.id,
		name: t.name,
		description: t.description,
		category: t.category,
		tags: t.tags,
		requirements: t.requirements,
		parameters: t.parameters,
	}))
}

export type { TemplateDefinition, TemplateMetadata, TemplateParameter, TemplateParameterValues, WidgetDef } from "./types"
