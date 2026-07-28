import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { toast } from "sonner"
import { DashboardTemplateId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"
import { LIST_LIMIT_MAX } from "@maple/domain/http/v2"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useDashboardMutationSync } from "@/hooks/use-dashboard-store"
import { formatBackendError } from "@/lib/error-messages"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TemplateList, type ReadinessFilter } from "@/components/dashboard-builder/templates/template-list"
import { TemplateDetailPanel } from "@/components/dashboard-builder/templates/template-detail-panel"
import { BLANK_TEMPLATE_ID } from "@/components/dashboard-builder/templates/template-summary"
import { useTemplateReadiness } from "@/components/dashboard-builder/templates/use-template-readiness"
import {
	ArrowLeftIcon,
	ArrowRotateClockwiseIcon,
	CircleWarningIcon,
	GridSquareCirclePlusIcon,
} from "@/components/icons"

const asTemplateId = Schema.decodeUnknownSync(DashboardTemplateId)

const TemplatesSearch = Schema.Struct({
	/** Selected template, so the panel is linkable and survives a reload. */
	template: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/dashboards/templates")({
	component: TemplatesPage,
	validateSearch: Schema.toStandardSchemaV1(TemplatesSearch),
})

function PanelRestState() {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<GridSquareCirclePlusIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>Pick a template</EmptyTitle>
				<EmptyDescription>
					You'll see every widget it builds, whether your data can fill them, and anything you need
					to name first.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}

function TemplatesPage() {
	const navigate = useNavigate()
	const search = Route.useSearch()

	// The catalogue is a fixed ~22 entries but the list envelope defaults to 20,
	// so an unbounded request silently drops the tail of the array.
	const listAtom = useMemo(
		() =>
			MapleApiV2AtomClient.query("dashboards", "listTemplates", {
				query: { limit: LIST_LIMIT_MAX },
				reactivityKeys: ["dashboard-templates"],
			}),
		[],
	)
	const listResult = useAtomValue(listAtom)
	const refreshList = useAtomRefresh(listAtom)

	const instantiate = useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "instantiateTemplate"), {
		mode: "promiseExit",
	})
	const { prepareForMutation, reconcileTxid } = useDashboardMutationSync()

	const [creating, setCreating] = useState(false)
	const [query, setQuery] = useState("")
	const [filter, setFilter] = useState<ReadinessFilter>("all")

	const panelIsSheet = useMediaQuery("max-lg")

	const templates = useMemo(() => (Result.isSuccess(listResult) ? listResult.value.data : []), [listResult])
	const loading = !Result.isSuccess(listResult) && !Result.isFailure(listResult)
	const failed = Result.isFailure(listResult)

	const { byId: readiness, resolved: readinessResolved } = useTemplateReadiness(templates)

	const selected = useMemo(
		() => templates.find((template) => template.id === search.template) ?? null,
		[templates, search.template],
	)

	const readyCount = useMemo(
		() =>
			templates.filter(
				(template) =>
					template.id !== BLANK_TEMPLATE_ID && readiness.get(template.id)?.ready !== false,
			).length,
		[templates, readiness],
	)
	const catalogueCount = templates.filter((template) => template.id !== BLANK_TEMPLATE_ID).length

	// Selection lives entirely in the URL. Below `lg` the sheet is open exactly
	// when something is selected, so a deep link to `?template=…` opens the panel
	// at any width and dismissing the sheet is the same act as deselecting.
	const setSelected = (templateId: string | undefined) => {
		void navigate({
			to: "/dashboards/templates",
			search: templateId === undefined ? {} : { template: templateId },
			replace: true,
		})
	}

	const createFromTemplate = async (templateId: string, parameters: Record<string, string>) => {
		setCreating(true)
		prepareForMutation()
		const result = await instantiate({
			params: { template_id: asTemplateId(templateId) },
			payload: Object.keys(parameters).length > 0 ? { parameters } : {},
			reactivityKeys: ["dashboards"],
		})
		setCreating(false)

		if (Exit.isFailure(result)) {
			const { title, description } = formatBackendError(result)
			toast.error(title, { description })
			return
		}

		const dashboard = result.value
		void reconcileTxid(dashboard.txid)
		toast.success(`Dashboard "${dashboard.name}" created`)
		void navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: dashboard.id } })
	}

	const panel = selected ? (
		<TemplateDetailPanel
			// Remount per template so parameter inputs don't carry over.
			key={selected.id}
			template={selected}
			readiness={readiness.get(selected.id)}
			creating={creating}
			onCreate={(parameters) => createFromTemplate(selected.id, parameters)}
		/>
	) : (
		<PanelRestState />
	)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Dashboards", href: "/dashboards" }, { label: "Templates" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<>
									<DashboardLayout.Title title="Start from a template">
										Start from a template
									</DashboardLayout.Title>
									{/* Lead with how many are usable right now — the catalogue
									    size is the less interesting half. Readiness fails open,
									    so until it resolves every template reads as ready;
									    stating the count then would flash a wrong number. */}
									{failed || loading || !readinessResolved ? (
										<DashboardLayout.Description>
											Pre-built dashboards for services, databases and infrastructure.
										</DashboardLayout.Description>
									) : (
										<div className="mt-1 flex items-center gap-2 text-xs">
											<span className="text-primary font-mono">
												{readyCount} ready for your data
											</span>
											<span className="text-muted-foreground">·</span>
											<span className="text-muted-foreground font-mono">
												{catalogueCount} templates
											</span>
										</div>
									)}
								</>
							}
						>
							<Button
								variant="outline"
								size="sm"
								onClick={() => navigate({ to: "/dashboards" })}
							>
								<ArrowLeftIcon size={14} data-icon="inline-start" />
								Back to dashboards
							</Button>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Fill>
						{failed ? (
							<Empty className="h-full">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<CircleWarningIcon size={18} />
									</EmptyMedia>
									<EmptyTitle>Couldn't load the templates</EmptyTitle>
									<EmptyDescription>
										The template catalogue didn't answer. Nothing you've built is affected
										— this page only reads.
									</EmptyDescription>
								</EmptyHeader>
								<div className="flex items-center gap-2">
									<Button size="sm" onClick={() => refreshList()}>
										<ArrowRotateClockwiseIcon size={13} data-icon="inline-start" />
										Try again
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => createFromTemplate(BLANK_TEMPLATE_ID, {})}
									>
										Start blank instead
									</Button>
								</div>
							</Empty>
						) : (
							<div className="flex h-full min-h-0">
								<div className="flex min-h-0 w-full flex-col border-border lg:w-[460px] lg:shrink-0 lg:border-r">
									<TemplateList
										templates={templates}
										readiness={readiness}
										selectedId={selected?.id ?? null}
										onSelect={(template) => setSelected(template.id)}
										onSelectBlank={() => createFromTemplate(BLANK_TEMPLATE_ID, {})}
										query={query}
										onQueryChange={(next) => setQuery(next ?? "")}
										filter={filter}
										onFilterChange={setFilter}
										loading={loading}
									/>
								</div>
								{/* `--panel-surface` is the colour the panel's sticky footer
								    paints and fades the scrolling preview into. It has to be
								    declared by whoever owns the surface — here the page, in the
								    sheet below its popover. */}
								{!panelIsSheet && (
									<div className="bg-background min-w-0 grow overflow-y-auto [--panel-surface:var(--background)]">
										{panel}
									</div>
								)}
							</div>
						)}
					</DashboardLayout.Fill>
				</DashboardLayout.Content>
			</DashboardLayout.Body>

			{panelIsSheet && (
				<Sheet
					open={selected !== null}
					onOpenChange={(open) => {
						if (!open) setSelected(undefined)
					}}
				>
					<SheetContent
						side="right"
						className="w-full overflow-y-auto p-0 [--panel-surface:var(--popover)] sm:max-w-lg"
					>
						<SheetHeader className="sr-only">
							<SheetTitle>{selected?.name ?? "Template"}</SheetTitle>
							<SheetDescription>What this template builds and what it needs.</SheetDescription>
						</SheetHeader>
						{panel}
					</SheetContent>
				</Sheet>
			)}
		</DashboardLayout.Root>
	)
}
