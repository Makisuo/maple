import { Link } from "@tanstack/react-router"

import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { CircleInfoIcon, CircleWarningIcon, CloudflareIcon, LoaderIcon } from "@/components/icons"
import { describeCloudflareIngestPhase, type CloudflareIngestPhase } from "./ingest-phase"

/**
 * The in-progress phases of a healthy new connection. They share one presentation — a spinner and
 * an explanation of when data lands — because to the reader they are one thing: "it's coming".
 */
const isWorking = (phase: CloudflareIngestPhase): boolean =>
	phase.kind === "discovering" || phase.kind === "collecting" || phase.kind === "backfilling"

/**
 * Explains an empty or half-empty Cloudflare page, above whatever data already exists. Renders
 * nothing once everything is live — a banner that says "working" forever is just chrome.
 */
export function CloudflareIngestBanner({ phase }: { phase: CloudflareIngestPhase }) {
	if (phase.kind === "live") return null
	const { title, description, tone } = describeCloudflareIngestPhase(phase)
	return (
		<Alert variant={tone}>
			{isWorking(phase) ? (
				<LoaderIcon size={16} className="animate-spin" />
			) : tone === "warning" ? (
				<CircleWarningIcon size={16} />
			) : (
				<CircleInfoIcon size={16} />
			)}
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{description}</AlertDescription>
		</Alert>
	)
}

/**
 * Full-page stand-in when a Cloudflare surface has nothing to draw yet. Same copy as the banner,
 * so a page that starts empty and later fills in never contradicts itself.
 */
export function CloudflareIngestEmpty({
	phase,
	children,
}: {
	phase: CloudflareIngestPhase
	/** Optional action row — e.g. a link back to the integration when something needs fixing. */
	children?: React.ReactNode
}) {
	const { title, description } = describeCloudflareIngestPhase(phase)
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					{isWorking(phase) ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<CloudflareIcon size={16} />
					)}
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{children ? <EmptyContent>{children}</EmptyContent> : null}
		</Empty>
	)
}

/** The one action a stalled connection has: re-grant access from the integrations page. */
export function CloudflareStalledAction() {
	return (
		<Button size="sm" variant="outline" render={<Link to="/integrations" />}>
			Check the connection
		</Button>
	)
}
