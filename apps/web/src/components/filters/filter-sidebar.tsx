// Frame/header/body/loading are promoted to @maple/ui (shared with the local-mode UI).
// FilterSidebarError stays here: it binds the app's ErrorState.
import { Separator } from "@maple/ui/components/ui/separator"
import {
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { ErrorState } from "@/components/common/error-state"

export {
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarBody,
	FilterSidebarLoading,
} from "@maple/ui/components/filters/filter-sidebar"

interface FilterSidebarErrorProps {
	error: unknown
	onRetry?: () => void
}

export function FilterSidebarError({ error, onRetry }: FilterSidebarErrorProps) {
	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader />
			<Separator className="my-2" />
			<ErrorState error={error} onRetry={onRetry} variant="inline" />
		</FilterSidebarFrame>
	)
}
