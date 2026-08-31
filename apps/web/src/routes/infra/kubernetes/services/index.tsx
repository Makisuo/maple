import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { KubernetesIcon } from "@/components/icons"
import { ServiceLensShell } from "@/components/infra/service-lens/service-lens-shell"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"

/**
 * The lens with nothing selected.
 *
 * Deliberately not a redirect to the worst service: the rail is already sorted
 * worst-first, so the choice is one click away, and auto-navigating would make
 * the URL you land on depend on data that changes under you.
 */

const searchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/services/")({
	component: ServiceLensIndexPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

function ServiceLensIndexPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	return (
		<ServiceLensShell
			startTime={search.startTime ?? startTime}
			endTime={search.endTime ?? endTime}
			timeSearch={search}
			timePreset={search.timePreset ?? (search.startTime ? undefined : "12h")}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
		>
			<Empty className="py-24">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<KubernetesIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>Pick a service</EmptyTitle>
					<EmptyDescription>
						This view answers one question — whether Kubernetes is why a service got slow — so it
						needs a service to ask it about. The rail is sorted worst-first.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</ServiceLensShell>
	)
}
