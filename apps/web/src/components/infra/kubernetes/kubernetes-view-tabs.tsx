import { Link } from "@tanstack/react-router"

import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

import { KubernetesIcon } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import { KUBERNETES_VIEWS, type KubernetesView } from "./views"

/**
 * The section's spine: one strip of views where four sidebar rows used to be.
 *
 * Each tab is a real link, so the views keep their own URLs (and ⌘-click, and
 * the back button). Only the time window travels between them — a pod filter
 * means nothing on the nodes list, and carrying it would make the other view
 * silently narrower than it looks.
 */
export function KubernetesViewTabs({
	view,
	timeSearch,
}: {
	view: KubernetesView
	timeSearch: TimeRangeSearch
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<KubernetesIcon size={18} className="shrink-0" />
			<Tabs value={view} className="min-w-0">
				<TabsList variant="underline" className="-mx-2 gap-x-1 py-0">
					{KUBERNETES_VIEWS.map((candidate) => (
						<TabsTrigger
							key={candidate.id}
							value={candidate.id}
							className="h-8 px-2 text-sm sm:h-8"
							// A tab that is a link: Base UI wants to know the element isn't a
							// <button>, or it warns and keeps button semantics on an anchor.
							nativeButton={false}
							render={<Link to={candidate.href} search={timeSearch} />}
						>
							{candidate.title}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
		</div>
	)
}
