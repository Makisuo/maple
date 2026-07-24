import type { ReactNode } from "react"
import { Toaster, toast } from "sonner"
import { cn } from "@maple/ui/utils"
import { AttributesProvider } from "@maple/ui/components/attributes"
import { Badge } from "@maple/ui/components/ui/badge"
import {
	CircleWarningIcon,
	CodeIcon,
	DatabaseIcon,
	EyeIcon,
	NetworkNodesIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { TraceListView } from "./views/trace-list-view"
import { TraceDetailView } from "./views/trace-detail-view"
import { LogsView } from "./views/logs-view"
import { MetricsListView } from "./views/metrics-list-view"
import { MetricDetailView } from "./views/metric-detail-view"
import { ErrorsView } from "./views/errors-view"
import { ServicesListView } from "./views/services-list-view"
import { ServiceDetailView } from "./views/service-detail-view"
import { SessionsListView } from "./views/sessions-list-view"
import { SessionDetailView } from "./views/session-detail-view"
import { navigate, useLocation } from "./lib/router"
import { ConnectButton } from "./components/connect-button"
import { IngestStatus } from "./components/ingest-status"
import { DisconnectedState } from "./components/view-states"
import { useLocalConnection } from "./hooks/use-local-connection"
import { highlightJson } from "./lib/highlight"

// Stable references so the AttributesProvider context value keeps its identity
// across renders (otherwise every CopyableValue consumer re-renders).
const notifyCopied = (message?: string) => toast.success(message ?? "Copied to clipboard")

type Route =
	| { name: "traces" }
	| { name: "trace-detail"; traceId: string }
	| { name: "logs" }
	| { name: "metrics" }
	| { name: "metric-detail"; metricName: string }
	| { name: "services" }
	| { name: "service-detail"; serviceName: string }
	| { name: "errors" }
	| { name: "sessions" }
	| { name: "session-detail"; sessionId: string }

function parseRoute(path: string): Route {
	const traceDetail = path.match(/^\/traces\/(.+)$/)
	if (traceDetail) return { name: "trace-detail", traceId: decodeURIComponent(traceDetail[1]) }
	const metricDetail = path.match(/^\/metrics\/(.+)$/)
	if (metricDetail) return { name: "metric-detail", metricName: decodeURIComponent(metricDetail[1]) }
	const serviceDetail = path.match(/^\/services\/(.+)$/)
	if (serviceDetail) return { name: "service-detail", serviceName: decodeURIComponent(serviceDetail[1]) }
	const sessionDetail = path.match(/^\/sessions\/(.+)$/)
	if (sessionDetail) return { name: "session-detail", sessionId: decodeURIComponent(sessionDetail[1]) }
	if (path.startsWith("/errors")) return { name: "errors" }
	if (path.startsWith("/logs")) return { name: "logs" }
	if (path.startsWith("/metrics")) return { name: "metrics" }
	if (path.startsWith("/services")) return { name: "services" }
	if (path.startsWith("/sessions")) return { name: "sessions" }
	return { name: "traces" }
}

type Tab = "traces" | "logs" | "metrics" | "services" | "errors" | "sessions"

function activeTab(route: Route): Tab {
	if (route.name === "errors") return "errors"
	if (route.name === "logs") return "logs"
	if (route.name === "metrics" || route.name === "metric-detail") return "metrics"
	if (route.name === "services" || route.name === "service-detail") return "services"
	if (route.name === "sessions" || route.name === "session-detail") return "sessions"
	return "traces"
}

export function App() {
	const { path, query } = useLocation()
	const route = parseRoute(path)
	const tab = activeTab(route)

	// When the local binary is unreachable, swap the views for a "how to connect"
	// screen instead of leaving an infinite skeleton. `connecting`/`connected`
	// fall through to the normal views, so the happy path is unchanged.
	const connection = useLocalConnection()

	// Carry the current filter context (full query) onto detail pages and back,
	// so opening an item and returning preserves the list's filters.
	const carry = () => new URLSearchParams(query)

	// Switching top-level tabs keeps the cross-cutting filters (service + range).
	const switchTab = (target: string) => {
		const shared = new URLSearchParams()
		const service = query.get("service")
		const range = query.get("range")
		if (service) shared.set("service", service)
		if (range) shared.set("range", range)
		navigate(target, shared)
	}

	return (
		<AttributesProvider notifyCopied={notifyCopied} highlightJson={highlightJson}>
			<div className="flex h-screen flex-col bg-background text-foreground">
				<header className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
					<span className="mr-3 flex items-center gap-1.5 font-display text-sm font-semibold">
						Maple
						<Badge
							variant="secondary"
							className="px-1.5 py-0 font-mono text-[10px] font-medium uppercase tracking-wider"
						>
							Local
						</Badge>
					</span>
					<NavTab
						label="Traces"
						icon={<NetworkNodesIcon size={14} />}
						active={tab === "traces"}
						onClick={() => switchTab("/traces")}
					/>
					<NavTab
						label="Logs"
						icon={<CodeIcon size={14} />}
						active={tab === "logs"}
						onClick={() => switchTab("/logs")}
					/>
					<NavTab
						label="Metrics"
						icon={<PulseIcon size={14} />}
						active={tab === "metrics"}
						onClick={() => switchTab("/metrics")}
					/>
					<NavTab
						label="Services"
						icon={<DatabaseIcon size={14} />}
						active={tab === "services"}
						onClick={() => switchTab("/services")}
					/>
					<NavTab
						label="Errors"
						icon={<CircleWarningIcon size={14} />}
						active={tab === "errors"}
						onClick={() => switchTab("/errors")}
					/>
					<NavTab
						label="Sessions"
						icon={<EyeIcon size={14} />}
						active={tab === "sessions"}
						onClick={() => switchTab("/sessions")}
					/>
					<div className="ml-auto flex items-center gap-3">
						<IngestStatus />
						<ConnectButton />
					</div>
				</header>

				<main className="min-h-0 flex-1">
					{connection.status === "disconnected" ? (
						<DisconnectedState onRetry={connection.retry} />
					) : route.name === "trace-detail" ? (
						<TraceDetailView
							traceId={route.traceId}
							onBack={() => navigate("/traces", carry())}
						/>
					) : route.name === "session-detail" ? (
						<SessionDetailView
							sessionId={route.sessionId}
							onBack={() => navigate("/sessions", carry())}
							onSelectTrace={(traceId) => navigate(`/traces/${encodeURIComponent(traceId)}`)}
						/>
					) : route.name === "metric-detail" ? (
						<MetricDetailView
							metricName={route.metricName}
							onBack={() => navigate("/metrics", carry())}
						/>
					) : route.name === "metrics" ? (
						<MetricsListView
							onSelectMetric={(metricName) =>
								navigate(`/metrics/${encodeURIComponent(metricName)}`, carry())
							}
						/>
					) : route.name === "service-detail" ? (
						<ServiceDetailView
							serviceName={route.serviceName}
							onBack={() => navigate("/services", carry())}
						/>
					) : route.name === "services" ? (
						<ServicesListView
							onSelectService={(serviceName) =>
								navigate(`/services/${encodeURIComponent(serviceName)}`, carry())
							}
						/>
					) : route.name === "errors" ? (
						<ErrorsView
							onSelectTrace={(traceId) =>
								navigate(`/traces/${encodeURIComponent(traceId)}`, carry())
							}
						/>
					) : route.name === "logs" ? (
						<LogsView />
					) : route.name === "sessions" ? (
						<SessionsListView
							onSelectSession={(sessionId) =>
								navigate(`/sessions/${encodeURIComponent(sessionId)}`, carry())
							}
						/>
					) : (
						<TraceListView
							onSelectTrace={(traceId) =>
								navigate(`/traces/${encodeURIComponent(traceId)}`, carry())
							}
						/>
					)}
				</main>
			</div>
			<Toaster position="bottom-right" theme="system" />
		</AttributesProvider>
	)
}

function NavTab({
	label,
	icon,
	active,
	onClick,
}: {
	label: string
	icon?: ReactNode
	active: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors",
				active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{icon ? (
				<span className={active ? "text-foreground" : "text-muted-foreground"}>{icon}</span>
			) : null}
			{label}
		</button>
	)
}
