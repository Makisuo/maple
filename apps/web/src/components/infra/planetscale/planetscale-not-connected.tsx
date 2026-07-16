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

import { PlanetScaleIcon } from "@/components/icons"

export function PlanetScaleNotConnected() {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<PlanetScaleIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>Connect PlanetScale to see database health</EmptyTitle>
				<EmptyDescription>
					Authorize your PlanetScale organization with one click and Maple tracks every
					branch&apos;s health — connections, CPU, memory, replication lag — with nothing to
					install.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button size="sm" render={<Link to="/integrations" search={{ integration: "planetscale" }} />}>
					Connect PlanetScale
				</Button>
			</EmptyContent>
		</Empty>
	)
}
