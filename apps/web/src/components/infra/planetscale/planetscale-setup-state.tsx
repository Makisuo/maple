// What /infra/planetscale shows before branch metrics have ever arrived.
//
// The connection is real — inventory, query insights and webhooks all work off
// the OAuth grant — but the metrics scrape is paused until someone adds a
// service token. The pages used to render their full chrome anyway: a stat rail
// of "—", a table whose five metric columns were all "—", and a grid of empty
// charts, with a small notice above it. That reads as a broken product, not an
// unfinished setup.
//
// This is the same species of screen as "not connected", so it uses the same
// family (IntegrationEmpty*) — the difference is that here the inventory is live
// and worth showing underneath.

import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"

import { PlanetScaleIcon } from "@/components/icons"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "@/components/integrations/integration-empty-state"
import { catalogEntry } from "@/components/integrations/integration-catalog"
import { PlanetScaleSetupChecklist } from "@/components/integrations/planetscale-setup-checklist"
import type { SetupStep } from "@/components/integrations/planetscale-setup-steps"

const PLANETSCALE_ENTRY = catalogEntry("planetscale")

/**
 * Metrics have never arrived for this connection. `steps` comes from
 * `derivePlanetScaleSetup`, so this screen and the integration card always agree
 * on which step is outstanding.
 */
export function PlanetScaleSetupState({ steps }: { steps: ReadonlyArray<SetupStep> }) {
	return (
		<IntegrationEmpty
			icon={PlanetScaleIcon}
			accent={PLANETSCALE_ENTRY.accent}
			iconClassName={PLANETSCALE_ENTRY.iconClassName}
		>
			<IntegrationEmptyFeatures>
				<IntegrationEmptyFeature
					label="Utilization"
					title="CPU, memory, connections"
					description="Per branch, scraped on a schedule — not sampled from your app."
				/>
				<IntegrationEmptyFeature
					label="Storage"
					title="Disk headroom over time"
					description="The slow-moving number nothing else in Maple reveals."
				/>
				<IntegrationEmptyFeature
					label="Replication"
					title="Replica lag per branch"
					description="Catch a replica falling behind before your reads go stale."
				/>
			</IntegrationEmptyFeatures>
			<IntegrationEmptyCard>
				<IntegrationEmptyMedia />
				<IntegrationEmptyHint>
					Branch metrics need one more step. PlanetScale only serves them to service tokens, so the
					OAuth authorization alone can&apos;t collect them.
				</IntegrationEmptyHint>
				<PlanetScaleSetupChecklist steps={steps} className="w-full max-w-md text-left" />
				<Button
					render={<Link to="/integrations" search={{ integration: "planetscale" }} />}
					// Deliberately not a token form inline: the integration page owns
					// setup, and two places to paste a token is one too many.
				>
					Finish setup
				</Button>
				<IntegrationEmptyFooter>
					One read-only permission · takes about a minute · your databases below are already live.
				</IntegrationEmptyFooter>
			</IntegrationEmptyCard>
		</IntegrationEmpty>
	)
}
