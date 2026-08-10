import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NodeCatalogueCanvas } from "@/components/investigations/flow/node-catalogue-canvas"

export const Route = createFileRoute("/node-lab")({
	component: NodeLab,
})

/**
 * Fixture-only gallery of every provenance-canvas node and edge state.
 *
 * Not linked from anywhere — URL-only, like the other lab surfaces. It renders
 * `node-catalogue.ts` and touches neither the warehouse nor the app database.
 */
function NodeLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Node Lab" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="flex flex-col">
							<div className="border-b px-4 py-3">
								<h1 className="text-sm font-semibold">Node Lab</h1>
								<p className="text-xs text-muted-foreground">
									Every provenance-canvas node and edge state, in the production renderer,
									at 1:1. Scroll the page; pan and zoom inside the canvas.
								</p>
							</div>
							<NodeCatalogueCanvas />
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
