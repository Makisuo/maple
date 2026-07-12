import {
	AlertWarningIcon,
	ChartLineIcon,
	CircleWarningIcon,
	DatabaseIcon,
	GlobeIcon,
	GridSquareCirclePlusIcon,
	type IconComponent,
	KafkaIcon,
	KubernetesIcon,
	LayersIcon,
	MongodbIcon,
	MysqlIcon,
	NatsIcon,
	NetworkNodesIcon,
	NodejsIcon,
	OpenjdkIcon,
	PaperPlaneIcon,
	PostgresIcon,
	PulseIcon,
	RabbitmqIcon,
	RedisIcon,
	ServerIcon,
} from "@/components/icons"

const TEMPLATE_ICONS: Record<string, IconComponent> = {
	"service-health": PulseIcon,
	"error-tracking": CircleWarningIcon,
	"platform-overview": LayersIcon,
	"http-endpoints": GlobeIcon,
	"top-errors": AlertWarningIcon,
	"metric-overview": ChartLineIcon,
	"jvm-runtime": OpenjdkIcon,
	"nodejs-runtime": NodejsIcon,
	"grpc-service": NetworkNodesIcon,
	blank: GridSquareCirclePlusIcon,
	"postgres-overview": PostgresIcon,
	"mysql-overview": MysqlIcon,
	"redis-overview": RedisIcon,
	"mongodb-overview": MongodbIcon,
	"host-metrics": ServerIcon,
	"kubernetes-cluster": KubernetesIcon,
	"kubernetes-pod": KubernetesIcon,
	"kafka-overview": KafkaIcon,
	"nats-overview": NatsIcon,
	"rabbitmq-overview": RabbitmqIcon,
}

// New server templates without a dedicated mark fall back to their category.
const CATEGORY_ICONS: Record<string, IconComponent> = {
	application: ChartLineIcon,
	database: DatabaseIcon,
	infrastructure: ServerIcon,
	messaging: PaperPlaneIcon,
}

export function templateIcon(templateId: string, category: string): IconComponent {
	return TEMPLATE_ICONS[templateId] ?? CATEGORY_ICONS[category] ?? ChartLineIcon
}
