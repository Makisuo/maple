import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { AlertsOverviewTab } from "@/components/alerts/overview/alerts-overview-tab"
import { AlertsSettingsTab, useDestinationManager } from "@/components/alerts/overview/settings-tab"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PlusIcon } from "@/components/icons"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

type AlertsTab = "overview" | "settings"

const AlertsSearch = Schema.Struct({
	/**
	 * Accepts any string so legacy deep links (`tab=monitor`, `tab=rules`) keep
	 * resolving — anything that isn't "settings" lands on the overview.
	 */
	tab: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	createdBy: Schema.optional(Schema.String),
	/** Health-summary filter over the rules list. */
	status: Schema.optional(Schema.Literals(["firing", "attention", "healthy", "disabled"])),
	/** Tag filter, shared by the incidents and rules lists. */
	tags: OptionalStringArrayParam,
	/** When set, the active list is grouped into per-tag sections. */
	groupByTag: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
})

export const Route = createFileRoute("/alerts/")({
	component: AlertsPage,
	validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

function AlertsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const activeTab: AlertsTab = search.tab === "settings" ? "settings" : "overview"

	// Session + destinations back the header action only; the tabs own the rest
	// of their data (the atoms are shared, so this costs no extra requests).
	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const { result: destinationsResult } = useAlertDestinationsList()
	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)
	const hasDestinations = Result.builder(destinationsResult)
		.onSuccess((response) => response.destinations.length > 0)
		.orElse(() => false)

	const destinationManager = useDestinationManager()

	const tabBar = (
		<Tabs
			value={activeTab}
			onValueChange={(tab) => navigate({ search: (prev) => ({ ...prev, tab: tab as AlertsTab }) })}
		>
			<TabsList variant="underline">
				<TabsTrigger value="overview">Overview</TabsTrigger>
				<TabsTrigger value="settings">Settings</TabsTrigger>
			</TabsList>
		</Tabs>
	)

	const headerActions =
		activeTab === "settings" ? (
			// Settings: the header owns the add action only once destinations exist.
			// While empty, the empty-state CTA is the single add affordance (avoids a duplicate).
			isAdmin && hasDestinations ? (
				<Button size="sm" onClick={() => destinationManager.openDialog()}>
					<PlusIcon size={14} />
					Add destination
				</Button>
			) : undefined
		) : (
			<Button
				size="sm"
				render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}
			>
				<PlusIcon size={14} />
				New rule
			</Button>
		)

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Alerts" }]}
			titleContent={
				<div>
					<div className="flex items-center gap-2">
						<h1 className="text-2xl font-semibold tracking-tight truncate">Alerts</h1>
					</div>
					<p className="text-muted-foreground">
						Monitor your services and get notified when things go wrong.
					</p>
				</div>
			}
			headerActions={headerActions}
			stickyContent={tabBar}
		>
			{activeTab === "overview" ? (
				<AlertsOverviewTab />
			) : (
				<AlertsSettingsTab manager={destinationManager} isAdmin={isAdmin} />
			)}
		</DashboardLayout>
	)
}
