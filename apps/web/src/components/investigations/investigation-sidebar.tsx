import { Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import type { AiTriageResult, AiTriageRunDocument } from "@maple/domain/http"

import { ArrowPathIcon, ArrowRightIcon } from "@/components/icons"
import { ConfidenceMeter, EYEBROW } from "@/components/ai-triage/ai-triage-card"
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/components/errors/severity-badge"
import { formatRelativeTime } from "@/lib/format"
import type { InvestigationSubject } from "./subject"

export interface InvestigationSidebarProps {
	subject: InvestigationSubject
	/** Latest completed result (drives the assessed severity + confidence); null while pending. */
	result: AiTriageResult | null
	/** Latest run (drives the investigated-at + model lines); null before the first run. */
	run: AiTriageRunDocument | null
	onRerun: () => void
	rerunning: boolean
	/** False when there's no incident to run triage against (disables Re-run). */
	canRun: boolean
}

/**
 * The investigation report's left meta rail — kind-agnostic. The Assessment block
 * shows the AI's severity + confidence + the subject's headline stat (breach /
 * deviation / occurrences); the rest renders `subject.groups` generically.
 */
export function InvestigationSidebar({
	subject,
	result,
	run,
	onRerun,
	rerunning,
	canRun,
}: InvestigationSidebarProps) {
	const investigatedAt = run?.completedAt ?? run?.createdAt ?? null
	const services = result ? [...new Set(result.evidence.flatMap((e) => e.relatedServices))] : []

	return (
		<div className="flex min-h-full flex-col">
			<Group label="Assessment">
				<Row label="Severity">
					{result ? (
						<Badge
							variant="outline"
							className={cn("capitalize", SEVERITY_TONE[result.severityAssessment])}
						>
							{SEVERITY_LABEL[result.severityAssessment]}
						</Badge>
					) : (
						<span className="text-sm text-muted-foreground/60">Pending</span>
					)}
				</Row>
				<Row label="Confidence">
					{result ? (
						<ConfidenceMeter confidence={result.confidence} showLabel={false} />
					) : (
						<span className="text-sm text-muted-foreground/60">Pending</span>
					)}
				</Row>
				{subject.headline ? (
					<div className="grid grid-cols-[88px_1fr] items-baseline gap-x-3 py-0.5">
						<span className="text-xs text-muted-foreground">{subject.headline.label}</span>
						<div className="flex min-w-0 flex-col items-end gap-0.5">
							<span className="font-mono text-sm tabular-nums text-foreground">
								{subject.headline.primary}
							</span>
							{subject.headline.secondary ? (
								<span
									className={cn(
										"whitespace-nowrap text-xs font-medium tabular-nums",
										subject.headline.bad ? "text-destructive" : "text-muted-foreground",
									)}
								>
									{subject.headline.secondary}
								</span>
							) : null}
						</div>
					</div>
				) : null}
			</Group>

			{subject.groups.map((group) => (
				<Group key={group.label} label={group.label}>
					{group.rows.map((row) => (
						<Row key={row.label} label={row.label} title={row.title}>
							{row.mono ? (
								<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
									{row.value}
								</code>
							) : (
								<span className="truncate text-sm text-foreground">{row.value}</span>
							)}
						</Row>
					))}
				</Group>
			))}

			{result ? (
				<Group label="Blast radius">
					<p className="text-sm leading-relaxed text-foreground">{result.affectedScope}</p>
					{services.length > 0 ? (
						<div className="flex flex-wrap gap-1 pt-1">
							{services.map((service) => (
								<Badge key={service} variant="outline" className="text-[11px]">
									{service}
								</Badge>
							))}
						</div>
					) : null}
				</Group>
			) : null}

			{investigatedAt ? (
				<Group label="Timing">
					<Row label="Investigated" title={new Date(investigatedAt).toLocaleString()}>
						<span className="text-right text-sm tabular-nums text-foreground">
							{formatRelativeTime(investigatedAt)}
						</span>
					</Row>
					{run?.model ? (
						<Row label="Model" title={run.model}>
							<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
								{run.model}
							</code>
						</Row>
					) : null}
				</Group>
			) : null}

			<div className="flex flex-col gap-2 pt-4">
				<Button
					size="sm"
					variant="outline"
					className="w-full"
					onClick={onRerun}
					disabled={rerunning || !canRun}
				>
					<ArrowPathIcon className="size-3.5" />
					Re-run diagnosis
				</Button>
				{subject.entityLinks.map((link) => (
					<Button
						key={link.href}
						size="sm"
						variant="ghost"
						className="w-full text-muted-foreground"
						render={<Link to={link.href} />}
					>
						{link.label}
						<ArrowRightIcon className="size-3" />
					</Button>
				))}
			</div>
		</div>
	)
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-b border-border/40 py-4 first:pt-0">
			<h3 className={EYEBROW}>{label}</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
	return (
		<div title={title} className="grid min-h-8 grid-cols-[88px_1fr] items-center gap-x-3 py-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}
