import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ChevronRightIcon, DockerIcon, KubernetesIcon, PlusIcon, ServerIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { InstallHostModal } from "@/components/infra/install-modal"
import { InfraIntegrations } from "@/components/infra/infra-integrations"
import { useInfraSurfaces } from "@/hooks/use-infra-surfaces"
import type { NavSurface } from "@/components/dashboard/nav-items"

export const Route = createFileRoute("/infra/discover")({
	component: DiscoverInfraPage,
})

/**
 * The collector half of the page. These three arrive over OTel from an agent you
 * run — unlike the integration half below, there is nothing to authorize, so the
 * call to action is an install snippet rather than an OAuth handshake.
 *
 * `surfaces` are the probe's names for the same things (see `useInfraSurfaces`).
 * A source counts as reporting when any of its surfaces does: Kubernetes is
 * three pages but one decision.
 */
interface CollectorSource {
	readonly name: string
	readonly icon: typeof ServerIcon
	readonly surfaces: ReadonlyArray<NavSurface>
	/** What you get once it reports — written as the payoff, not the mechanism. */
	readonly blurb: string
	/** Where to look once it's live. */
	readonly to: "/infra" | "/infra/containers" | "/infra/kubernetes/pods"
	/** Which tab the install modal opens on. */
	readonly tab: "kubernetes" | "docker"
}

const COLLECTOR_SOURCES: ReadonlyArray<CollectorSource> = [
	{
		name: "Hosts",
		icon: ServerIcon,
		surfaces: ["hosts"],
		blurb: "CPU, memory, disk and network",
		to: "/infra",
		tab: "kubernetes",
	},
	{
		name: "Containers",
		icon: DockerIcon,
		surfaces: ["containers"],
		blurb: "CPU and memory per container",
		to: "/infra/containers",
		tab: "docker",
	},
	{
		name: "Kubernetes",
		icon: KubernetesIcon,
		surfaces: ["k8sPods", "k8sNodes", "k8sWorkloads"],
		blurb: "Pods, nodes and workloads",
		to: "/infra/kubernetes/pods",
		tab: "kubernetes",
	},
]

function DiscoverInfraPage() {
	const [installOpen, setInstallOpen] = useState(false)
	const [installTab, setInstallTab] = useState<"kubernetes" | "docker">("kubernetes")
	const surfaces = useInfraSurfaces()

	const openInstall = (tab: "kubernetes" | "docker") => {
		setInstallTab(tab)
		setInstallOpen(true)
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Infrastructure", href: "/infra" }, { label: "Add sources" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="space-y-8">
							<PageHero
								title="Add infrastructure"
								description="Everything Maple can watch, and what each source needs before it reports. The sidebar lists the ones already sending data."
								actions={
									<Button size="sm" onClick={() => openInstall("kubernetes")}>
										<PlusIcon size={14} />
										Install a collector
									</Button>
								}
							/>

							<section className="space-y-3">
								<div className="space-y-0.5">
									<h2 className="font-semibold text-sm">Collectors</h2>
									<p className="text-muted-foreground text-xs">
										Run the Maple agent next to your workloads.
									</p>
								</div>
								<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
									{COLLECTOR_SOURCES.map((source) => (
										<CollectorCard
											key={source.name}
											source={source}
											// `null` while the probe is unresolved — the card
											// says nothing rather than claiming "not reporting".
											reporting={
												surfaces === null
													? null
													: source.surfaces.some((surface) =>
															surfaces.has(surface),
														)
											}
											onInstall={() => openInstall(source.tab)}
										/>
									))}
								</div>
							</section>

							<InfraIntegrations />
						</div>

						<InstallHostModal
							open={installOpen}
							onOpenChange={setInstallOpen}
							defaultTab={installTab}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/**
 * Mirrors `InfraSourceCard` in the integrations strip below it — same plate,
 * same status line, same chevron — so the two halves of the page read as one
 * list of sources rather than two unrelated grids.
 *
 * A reporting source links to its page; one that isn't opens the install
 * snippet, because "go look at the empty list" is not the next step.
 */
function CollectorCard({
	source,
	reporting,
	onInstall,
}: {
	source: CollectorSource
	reporting: boolean | null
	onInstall: () => void
}) {
	const body = (
		<>
			<span
				aria-hidden
				className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card"
			>
				<span className="absolute inset-0 rounded-[inherit] bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--muted-foreground)_22%,transparent),transparent_70%)]" />
				<source.icon className="relative size-5" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-semibold text-sm">{source.name}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
					{reporting ? (
						<>
							<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
							<span className="truncate">Reporting</span>
						</>
					) : (
						<span className="truncate">{source.blurb}</span>
					)}
				</span>
			</span>
			{reporting === false ? (
				<Badge variant="outline" size="sm">
					Install
				</Badge>
			) : null}
			<ChevronRightIcon
				size={14}
				className="shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
			/>
		</>
	)

	const className =
		"group flex items-center gap-3 rounded-lg border border-border/60 bg-card p-3 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"

	// `reporting === null` (probe unresolved) links rather than installs: sending
	// someone to a page they may already have data on is the recoverable mistake.
	return reporting === false ? (
		<button type="button" onClick={onInstall} className={cn(className, "w-full")}>
			{body}
		</button>
	) : (
		<Link to={source.to} className={className}>
			{body}
		</Link>
	)
}
