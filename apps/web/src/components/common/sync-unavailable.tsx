import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { CircleWarningIcon } from "@/components/icons"

/**
 * The terminal state of an ElectricSQL-backed page: the shape stream could not
 * be established and has stopped retrying.
 *
 * It always carries a retry action. Both recovery budgets (the collection
 * factory's backoff and the org-collections heal) are bounded on purpose, so
 * once they are spent nothing in the app will try again — without a button the
 * only way forward is a page reload, which is exactly the dead end this replaces.
 */
export function SyncUnavailable({
	title,
	description,
	onRetry,
}: {
	title: string
	description: string
	onRetry: () => void
}) {
	return (
		<Empty className="py-12">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CircleWarningIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button size="sm" variant="outline" onClick={onRetry}>
					Try again
				</Button>
			</EmptyContent>
		</Empty>
	)
}

/**
 * The banner for a page reading a plain-HTTP snapshot because live sync is down:
 * the rows are real but frozen, and writes are disabled. Distinct from
 * {@link SyncUnavailable} — there is data on screen, so this must inform without
 * taking the page over.
 */
export function SyncDegradedBanner({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mb-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
			<CircleWarningIcon size={14} className="mt-0.5 shrink-0" />
			<span className="flex-1">
				Live sync is unavailable, so this is a snapshot loaded over HTTP — it won’t update on its own
				and editing is disabled.
			</span>
			<Button
				size="sm"
				variant="ghost"
				onClick={onRetry}
				className="-my-1 h-6 shrink-0 px-2 text-xs hover:text-foreground"
			>
				Retry sync
			</Button>
		</div>
	)
}
