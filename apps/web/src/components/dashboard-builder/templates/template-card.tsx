import type { DashboardTemplatePreviewWidget } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/utils"
import { ArrowRightIcon } from "@/components/icons"
import { templateIcon } from "./template-icons"
import { TemplatePreview } from "./template-preview"

function compositionLabel(preview: ReadonlyArray<DashboardTemplatePreviewWidget>): string {
	const counts = { stat: 0, chart: 0, table: 0, list: 0 }
	for (const widget of preview) {
		if (widget.kind === "stat") counts.stat++
		else if (widget.kind === "table") counts.table++
		else if (widget.kind === "list") counts.list++
		else counts.chart++
	}
	const parts: string[] = []
	if (counts.stat > 0) parts.push(`${counts.stat} ${counts.stat === 1 ? "stat" : "stats"}`)
	if (counts.chart > 0) parts.push(`${counts.chart} ${counts.chart === 1 ? "chart" : "charts"}`)
	if (counts.table > 0) parts.push(`${counts.table} ${counts.table === 1 ? "table" : "tables"}`)
	if (counts.list > 0) parts.push(`${counts.list} ${counts.list === 1 ? "list" : "lists"}`)
	return parts.join(" · ")
}

interface TemplateCardProps {
	id: string
	name: string
	description: string
	category: string
	tags: readonly string[]
	requirements: readonly string[]
	preview: ReadonlyArray<DashboardTemplatePreviewWidget>
	disabled?: boolean
	/**
	 * The org has no data matching the template's required metrics — the card
	 * is dimmed and badged but stays usable (informative, not blocking).
	 */
	noMatchingData?: boolean
	onUse: () => void
}

export function TemplateCard({
	id,
	name,
	description,
	category,
	tags,
	requirements,
	preview,
	disabled = false,
	noMatchingData = false,
	onUse,
}: TemplateCardProps) {
	const Icon = templateIcon(id, category)
	const composition = compositionLabel(preview)
	return (
		<div
			className={cn(
				"group ring-1 ring-border hover:ring-border-active bg-card flex h-full flex-col overflow-hidden rounded-md transition-all",
				noMatchingData && "opacity-60 hover:opacity-100",
			)}
		>
			<div className="border-b border-border bg-sidebar/60">
				<TemplatePreview templateId={id} preview={preview} className="h-28 w-full" />
			</div>
			<div className="flex flex-1 flex-col gap-2 p-4">
				<div className="flex items-center gap-2">
					<Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="text-sm font-semibold text-foreground">{name}</span>
					{noMatchingData && (
						<Badge
							variant="outline"
							className="ml-auto shrink-0 text-[10px] px-1.5 py-0 h-4 font-medium text-muted-foreground"
							title="This template queries metrics your org isn't sending yet — it would render empty."
						>
							No matching data yet
						</Badge>
					)}
				</div>
				<p className="text-xs text-dim leading-relaxed">{description}</p>
				{composition.length > 0 && (
					<span className="font-mono text-[10px] text-dim">{composition}</span>
				)}
				{requirements.length > 0 && (
					<div className="flex flex-wrap items-center gap-1 mt-1">
						{requirements.map((req) => (
							<Badge
								key={req}
								variant="outline"
								className="text-[10px] px-1.5 py-0 h-4 font-medium"
							>
								{req}
							</Badge>
						))}
					</div>
				)}
				{tags.length > 0 && (
					<div className="flex flex-wrap items-center gap-1">
						{tags.map((tag) => (
							<Badge
								key={tag}
								variant="secondary"
								className="text-[10px] px-1.5 py-0 h-4 font-medium"
							>
								{tag}
							</Badge>
						))}
					</div>
				)}
				<div className="mt-auto flex justify-end pt-2">
					<Button size="sm" variant="outline" disabled={disabled} onClick={onUse}>
						Use template
						<ArrowRightIcon size={14} data-icon="inline-end" />
					</Button>
				</div>
			</div>
		</div>
	)
}
