import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { formatRelativeTime } from "./format"

export interface ScheduledScrapeStatus {
	readonly label: string
	readonly detail: string
	readonly dotClass: string
	readonly badgeVariant: "outline" | "warning" | "success" | "error"
}

type TargetStatusFields = Pick<V2ScrapeTarget, "enabled" | "last_scrape_at" | "last_scrape_error">

const disabledStatus = (): ScheduledScrapeStatus => ({
	label: "Disabled",
	detail: "Collector skips this target",
	dotClass: "bg-muted-foreground/30",
	badgeVariant: "outline",
})

/** List-row status from the rollup fields already returned by the targets API. */
export function scheduledStatusFromRollup(target: TargetStatusFields): ScheduledScrapeStatus {
	if (!target.enabled) return disabledStatus()
	if (target.last_scrape_error !== null) {
		return {
			label: "Down",
			detail:
				target.last_scrape_at === null
					? "No successful scheduled scrape"
					: `Last success ${formatRelativeTime(target.last_scrape_at)}`,
			dotClass: "bg-destructive",
			badgeVariant: "error",
		}
	}
	if (target.last_scrape_at === null) {
		return {
			label: "No checks",
			detail: "No scheduled scrape observed",
			dotClass: "bg-severity-warn",
			badgeVariant: "warning",
		}
	}
	return {
		label: "Up",
		detail: `Scheduled ${formatRelativeTime(target.last_scrape_at)}`,
		dotClass: "bg-severity-info",
		badgeVariant: "success",
	}
}

/** Detail-panel status from the selected target's latest persisted check. */
export function scheduledStatusFromChecks(
	target: Pick<V2ScrapeTarget, "enabled">,
	latestCheck: V2ScrapeTargetCheck | null,
	isLoading: boolean,
	checksUnavailable: boolean,
): ScheduledScrapeStatus {
	if (!target.enabled) return disabledStatus()
	if (isLoading) {
		return {
			label: "Checking",
			detail: "Loading scheduled history",
			dotClass: "bg-muted-foreground/40",
			badgeVariant: "outline",
		}
	}
	if (checksUnavailable) {
		return {
			label: "Unavailable",
			detail: "Failed to load scheduled checks",
			dotClass: "bg-muted-foreground/40",
			badgeVariant: "outline",
		}
	}
	if (latestCheck === null) {
		return {
			label: "No checks",
			detail: "No scheduled scrape observed",
			dotClass: "bg-severity-warn",
			badgeVariant: "warning",
		}
	}
	if (latestCheck.success) {
		return {
			label: "Up",
			detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
			dotClass: "bg-severity-info",
			badgeVariant: "success",
		}
	}
	return {
		label: "Down",
		detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
		dotClass: "bg-destructive",
		badgeVariant: "error",
	}
}
