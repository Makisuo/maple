import { useState } from "react"

import { CloudflareLogpushSection } from "@/components/settings/cloudflare-logpush-section"
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { FireIcon, ShieldIcon } from "@/components/icons"

export function ConnectorsSection() {
	const [tab, setTab] = useState<"cloudflare" | "prometheus">("cloudflare")

	return (
		<Tabs value={tab} onValueChange={(v) => setTab(v as "cloudflare" | "prometheus")}>
			<TabsList variant="line">
				<TabsTrigger value="cloudflare">
					<ShieldIcon size={14} />
					Cloudflare Logpush
				</TabsTrigger>
				<TabsTrigger value="prometheus">
					<FireIcon size={14} />
					Prometheus
				</TabsTrigger>
			</TabsList>
			<TabsContent value="cloudflare" className="pt-4" keepMounted>
				<CloudflareLogpushSection />
			</TabsContent>
			<TabsContent value="prometheus" className="pt-4" keepMounted>
				<ScrapeTargetsSection />
			</TabsContent>
		</Tabs>
	)
}
