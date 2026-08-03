import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { CopyButton } from "@maple/ui/components/ui/copy-button"

import { ServerIcon } from "@/components/icons"
import type { HostDetailSummaryResponse } from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

interface HostMetadataPanelProps {
	summary: HostDetailSummaryResponse["data"]
}

// Candidate for DetailRail.MetaRow (@maple/ui) — same mono label/value pair, but
// this one layers on copy-on-hover and an optional tooltip. Fold in if MetaRow
// ever grows those.
interface RowProps {
	label: string
	value: string | null | undefined
	copyValue?: string
	tooltip?: string
}

function Row({ label, value, copyValue, tooltip }: RowProps) {
	if (!value) return null

	const valueNode = (
		<span className="break-all text-right font-mono text-[11px] tabular-nums text-foreground/85">
			{value}
		</span>
	)

	return (
		<div className="group flex items-baseline justify-between gap-3 py-1.5">
			<span className="font-mono text-[11px] text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center gap-1.5 text-[11px]">
				{tooltip ? (
					<Tooltip>
						<TooltipTrigger render={<span />} className="cursor-default">
							{valueNode}
						</TooltipTrigger>
						<TooltipContent>{tooltip}</TooltipContent>
					</Tooltip>
				) : (
					valueNode
				)}
				<CopyButton
					value={copyValue ?? value}
					label={label}
					// One per row; the hover-revealed glyph is the feedback here.
					toast={false}
					iconSize={11}
					className="size-5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
				/>
			</div>
		</div>
	)
}

interface SectionProps {
	title: string
	children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
	return (
		<div className="space-y-0.5 py-2 first:pt-0 last:pb-0">
			<div className="text-[11px] font-medium text-muted-foreground">{title}</div>
			<div className="divide-y divide-border/60">{children}</div>
		</div>
	)
}

export function HostMetadataPanel({ summary }: HostMetadataPanelProps) {
	if (!summary) return null

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<ServerIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="divide-y divide-border/60">
				<Section title="Identity">
					<Row label="host.name" value={summary.hostName} />
				</Section>
				<Section title="Platform">
					<Row label="os.type" value={summary.osType} />
					<Row label="host.arch" value={summary.hostArch} />
				</Section>
				<Section title="Cloud">
					<Row label="cloud.provider" value={summary.cloudProvider} />
					<Row label="cloud.region" value={summary.cloudRegion} />
				</Section>
				<Section title="Lifecycle">
					<Row
						label="first seen"
						value={formatRelativeTime(summary.firstSeen)}
						copyValue={summary.firstSeen}
						tooltip={summary.firstSeen}
					/>
					<Row
						label="last seen"
						value={formatRelativeTime(summary.lastSeen)}
						copyValue={summary.lastSeen}
						tooltip={summary.lastSeen}
					/>
				</Section>
			</CardContent>
		</Card>
	)
}
