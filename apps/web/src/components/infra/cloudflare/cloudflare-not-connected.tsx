import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { CloudflareIcon } from "@/components/icons"

interface CloudflareNotConnectedProps {
	/**
	 * `not-connected`: no Cloudflare OAuth connection at all.
	 * `needs-permissions`: connected, but the grant predates the analytics
	 * scopes — reconnecting re-consents with the full scope set.
	 */
	variant: "not-connected" | "needs-permissions"
}

export function CloudflareNotConnected({ variant }: CloudflareNotConnectedProps) {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CloudflareIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>
					{variant === "not-connected"
						? "Connect Cloudflare to see edge analytics"
						: "Update Cloudflare permissions"}
				</EmptyTitle>
				<EmptyDescription>
					{variant === "not-connected"
						? "Connect your Cloudflare account and Maple will continuously ingest zone HTTP analytics and Workers invocation metrics — no agents or Logpush setup required."
						: "Your Cloudflare connection is missing the analytics read scopes. Reconnect to grant them and analytics polling will start automatically."}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button size="sm" render={<Link to="/integrations" />}>
					{variant === "not-connected" ? "Connect Cloudflare" : "Reconnect Cloudflare"}
				</Button>
			</EmptyContent>
		</Empty>
	)
}
