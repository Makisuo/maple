import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"

import { ArrowRotateClockwiseIcon } from "@/components/icons"
import { useAppVersionChanged } from "@/hooks/use-app-version"

// Dev-only escape hatch, mirroring `QuotaBanner`'s: load any page with
// `?version_preview=1` to eyeball the banner without deploying twice. Compiled
// out of production builds.
function previewRequested(): boolean {
	if (!import.meta.env.DEV || typeof window === "undefined") return false
	return new URLSearchParams(window.location.search).get("version_preview") === "1"
}

/**
 * Shown when the server is serving a newer build than this tab is running.
 *
 * Deliberately NOT dismissible. Every other banner in the shell is advisory —
 * this one means the code in this tab is out of date, which during a stored-schema
 * rollout can mean it cannot read documents the current build writes. A tab that
 * dismissed it would go on silently failing to decode dashboards, and the user
 * would have no way back to the prompt that explains why.
 *
 * The copy matches `StaleChunkError` in `lib/error-messages.ts` word for word.
 * Same event from the user's side — Maple was updated, reload to catch up — and
 * they should not have to work out that the banner and the error screen are
 * talking about the same thing.
 */
export function AppUpdateBanner() {
	const changed = useAppVersionChanged()

	if (!changed && !previewRequested()) return null

	return (
		<div className="px-4 pt-3">
			<Alert>
				<ArrowRotateClockwiseIcon size={16} />
				<AlertTitle>Maple was updated</AlertTitle>
				<AlertDescription>Reload to use the latest version.</AlertDescription>
				<AlertAction>
					<Button size="sm" onClick={() => window.location.reload()}>
						Reload
					</Button>
				</AlertAction>
			</Alert>
		</div>
	)
}
