import { Button } from "@maple/ui/components/ui/button"

import { ArrowRotateAnticlockwiseIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"

import { usePageRefreshContext } from "./page-refresh-context"

export function ReloadControls() {
	const { isReloading, reload } = usePageRefreshContext()

	return (
		<Button type="button" variant="outline" size="sm" onClick={reload} disabled={isReloading}>
			<ArrowRotateAnticlockwiseIcon className={cn("size-3.5", isReloading && "animate-spin")} />
			<span>Reload</span>
		</Button>
	)
}
