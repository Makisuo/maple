import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { IngestionSection } from "@/components/settings/ingestion-section"

const DeveloperSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(["ingestion", "api-keys"])),
})

export const Route = createFileRoute("/developer")({
	component: DeveloperPage,
	validateSearch: Schema.toStandardSchemaV1(DeveloperSearch),
})

function DeveloperPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Developer" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Developer"
							description="Manage API keys and ingestion credentials."
						/>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<Tabs
							value={search.tab ?? "ingestion"}
							onValueChange={(tab) =>
								navigate({ search: { tab: tab as "ingestion" | "api-keys" } })
							}
						>
							<TabsList variant="underline">
								<TabsTrigger value="ingestion">Ingestion</TabsTrigger>
								<TabsTrigger value="api-keys">API Keys</TabsTrigger>
							</TabsList>
							<TabsContent value="ingestion" className="pt-4">
								<IngestionSection />
							</TabsContent>
							<TabsContent value="api-keys" className="pt-4">
								<ApiKeysSection />
							</TabsContent>
						</Tabs>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
