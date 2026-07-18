import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { toast } from "sonner"
import { DashboardTemplateId } from "@maple/domain/http"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useDashboardMutationSync } from "@/hooks/use-dashboard-store"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TemplatePicker } from "@/components/dashboard-builder/templates/template-picker"
import { Button } from "@maple/ui/components/ui/button"
import { ArrowLeftIcon } from "@/components/icons"

const asTemplateId = Schema.decodeUnknownSync(DashboardTemplateId)

export const Route = createFileRoute("/dashboards/templates")({
	component: TemplatesPage,
})

function TemplatesPage() {
	const navigate = useNavigate()
	const listResult = useAtomValue(
		MapleApiV2AtomClient.query("dashboards", "listTemplates", {
			query: {},
			reactivityKeys: ["dashboard-templates"],
		}),
	)
	const instantiate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "instantiateTemplate"), {
		mode: "promiseExit",
	})
	const { prepareForMutation, reconcileTxid } = useDashboardMutationSync()

	const submitting = false
	const templates = Result.isSuccess(listResult) ? listResult.value.data : []
	const failed = Result.isFailure(listResult)

	const handleUse = async (templateId: string, parameters: Record<string, string>) => {
		try {
			prepareForMutation()
			const result = await instantiate({
				params: { template_id: asTemplateId(templateId) },
				payload: {
					...(Object.keys(parameters).length > 0 && { parameters }),
				},
				reactivityKeys: ["dashboards"],
			})

			if (Exit.isFailure(result)) {
				toast.error("Failed to create dashboard from template")
				return
			}

			const dashboard = result.value
			void reconcileTxid(dashboard.txid)
			toast.success(`Dashboard "${dashboard.name}" created`)
			navigate({
				to: "/dashboards/$dashboardId",
				params: { dashboardId: dashboard.id },
			})
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to create dashboard")
		}
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "Templates" }]}
			title="Dashboard Templates"
			description="Pre-built dashboards for common services, databases, infrastructure, and messaging."
			headerActions={
				<Button variant="outline" size="sm" onClick={() => navigate({ to: "/dashboards" })}>
					<ArrowLeftIcon size={14} data-icon="inline-start" />
					Back to dashboards
				</Button>
			}
		>
			{failed && (
				<div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
					Failed to load templates. Try refreshing the page.
				</div>
			)}
			{!Result.isSuccess(listResult) && !failed ? (
				<div className="py-12 text-sm text-muted-foreground">Loading templates…</div>
			) : (
				<TemplatePicker templates={templates} submitting={submitting} onUse={handleUse} />
			)}
		</DashboardLayout>
	)
}
