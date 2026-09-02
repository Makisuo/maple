import type { ReactNode } from "react"
import { defaultStringifySearch } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { pickTimeRangeSearch, type TimeRangeSearch } from "@/components/time-range-picker/search"
import type { TimeRange } from "@/components/time-range-picker/types"

import { KubernetesViewTabs } from "./kubernetes-view-tabs"
import { KUBERNETES_ROOT, kubernetesView, type KubernetesView } from "./views"

/**
 * The chrome every Kubernetes page shares: breadcrumbs, the view tabs, and ONE
 * time control that lives in the URL.
 *
 * Before this the section was four pages that happened to be siblings — three
 * filter-rail lists, a lens with its own rail, and detail pages that each hid a
 * local time `Select`, so clicking into a pod silently reset you to the last
 * hour. Now a list, a lens and a detail page are the same page with different
 * middles, and the window you picked follows you through all of them.
 */

interface KubernetesShellProps {
	view: KubernetesView
	/**
	 * Breadcrumb entries after the view — a detail page's own name. When present,
	 * the view crumb becomes a link back to its list, window intact.
	 */
	trail?: ReadonlyArray<{ label: string; href?: string }>
	/** The page's raw URL search — only the window is read from it. */
	timeSearch: TimeRangeSearch
	/** The effective window, for the control's display when the URL carries none. */
	startTime: string
	endTime: string
	/** "12h" for the lists, "1h" for a detail page. */
	defaultPreset: string
	onTimeChange: (range: TimeRange, options?: { replace?: boolean }) => void
	/** The left rail — a filter sidebar, or the lens's service switcher. */
	filters?: ReactNode
	/** Tailwind width class for a rail whose content needs more than `w-64`. */
	filtersWidth?: string
	rightPanel?: ReactNode
	children: ReactNode
}

export function KubernetesShell({
	view,
	trail = [],
	timeSearch,
	startTime,
	endTime,
	defaultPreset,
	onTimeChange,
	filters,
	filtersWidth,
	rightPanel,
	children,
}: KubernetesShellProps) {
	const current = kubernetesView(view)
	const window = pickTimeRangeSearch(timeSearch)
	// Breadcrumb hrefs are strings; the window rides along as a query so the
	// crumb lands you back on the list you left, not on the default hour.
	const query = defaultStringifySearch(window)

	return (
		<PageRefreshProvider timePreset={timeSearch.timePreset ?? defaultPreset}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Kubernetes", href: `${KUBERNETES_ROOT}${query}` },
						trail.length > 0
							? { label: current.title, href: `${current.href}${query}` }
							: { label: current.title },
						...trail,
					]}
				/>
				<DashboardLayout.Body>
					{filters ? (
						<DashboardLayout.Filters width={filtersWidth}>{filters}</DashboardLayout.Filters>
					) : null}
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								titleContent={<KubernetesViewTabs view={view} timeSearch={window} />}
							>
								<TimeRangeHeaderControls
									startTime={timeSearch.startTime ?? startTime}
									endTime={timeSearch.endTime ?? endTime}
									presetValue={
										timeSearch.timePreset ??
										(timeSearch.startTime ? undefined : defaultPreset)
									}
									onTimeChange={onTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
					</DashboardLayout.Content>
					{rightPanel ? (
						<DashboardLayout.RightPanel>{rightPanel}</DashboardLayout.RightPanel>
					) : null}
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
