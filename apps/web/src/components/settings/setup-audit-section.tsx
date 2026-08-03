import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import type { V2SetupAudit, V2SetupAuditCheck } from "@maple/domain/http/v2"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRotateAnticlockwiseIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	ServerIcon,
	type IconComponent,
} from "@/components/icons"
import { setupAuditAtom } from "@/lib/services/atoms/audit-atoms"
import type { SettingsTab } from "@/components/settings/settings-nav"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

type Severity = V2SetupAuditCheck["severity"]
type Category = V2SetupAuditCheck["category"]

const SEVERITY: Record<Severity, { label: string; icon: IconComponent; className: string }> = {
	critical: { label: "Critical", icon: CircleWarningIcon, className: "text-destructive" },
	warn: { label: "Warning", icon: CircleWarningIcon, className: "text-warning" },
	info: { label: "Info", icon: CircleInfoIcon, className: "text-info" },
}

const SEVERITY_ORDER: ReadonlyArray<Severity> = ["critical", "warn", "info"]

/**
 * Each category's owning surface, so a finding is one click from where it gets fixed. `tab` targets a
 * sibling settings tab; `to` targets a standalone route. Kept as separate fields because TanStack
 * Router types `search` per route — a widened `object` does not typecheck.
 */
type CategoryTarget =
	| { label: string; fixLabel: string; tab: SettingsTab }
	| { label: string; fixLabel: string; to: "/alerts" | "/traces" | "/integrations" }

const CATEGORY: Record<Category, CategoryTarget> = {
	alerting: { label: "Alerting", fixLabel: "Open alerts", to: "/alerts" },
	notifications: { label: "Notifications", fixLabel: "Open notifications", tab: "notifications" },
	ingestion: { label: "Ingestion", fixLabel: "Open ingestion", tab: "ingestion" },
	attributes: { label: "Attributes", fixLabel: "Open ingestion", tab: "ingestion" },
	traces: { label: "Traces", fixLabel: "Open traces", to: "/traces" },
	integrations: { label: "Integrations", fixLabel: "Open integrations", to: "/integrations" },
	data_platform: { label: "Data platform", fixLabel: "Open data platform", tab: "data-platform" },
}

function CategoryLink({
	target,
	label,
	className,
}: {
	target: CategoryTarget
	label: string
	className: string
}) {
	return "tab" in target ? (
		<Link to="/settings" search={{ tab: target.tab }} className={className}>
			{label}
		</Link>
	) : (
		<Link to={target.to} className={className}>
			{label}
		</Link>
	)
}

const CATEGORY_ORDER: ReadonlyArray<Category> = [
	"alerting",
	"notifications",
	"ingestion",
	"attributes",
	"traces",
	"integrations",
	"data_platform",
]

function SummaryPill({ count, label, className }: { count: number; label: string; className: string }) {
	return (
		<span className={cn("font-mono text-[11px] leading-3.5", count === 0 && "text-muted-foreground")}>
			<span className={cn("font-medium", count > 0 && className)}>{count}</span> {label}
		</span>
	)
}

function CheckRow({ check }: { check: V2SetupAuditCheck }) {
	const severity = SEVERITY[check.severity]
	const category = CATEGORY[check.category]
	const isFinding = check.status === "fail"
	const Icon = isFinding ? severity.icon : check.status === "pass" ? CircleCheckIcon : CircleInfoIcon

	return (
		<div className="flex items-start gap-3 border-t px-4 py-3">
			<Icon
				size={16}
				className={cn("mt-0.5 shrink-0", isFinding ? severity.className : "text-muted-foreground/60")}
			/>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{check.title}</span>
					<code className="text-muted-foreground font-mono text-[11px]">{check.id}</code>
					{check.status === "skip" && (
						<Badge variant="secondary" className="text-[10px]">
							Skipped
						</Badge>
					)}
				</div>
				{check.detail !== null && (
					<p className="text-muted-foreground text-xs leading-relaxed">{check.detail}</p>
				)}
				{check.affected.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5 pt-0.5">
						{check.affected.map((entity) => (
							<span
								key={`${entity.kind}:${entity.name}`}
								title={entity.note ?? undefined}
								className="bg-muted/60 text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px] leading-4"
							>
								{entity.name}
							</span>
						))}
						{check.affected_count > check.affected.length && (
							<span className="text-muted-foreground/70 text-[11px]">
								+{check.affected_count - check.affected.length} more
							</span>
						)}
					</div>
				)}
				{isFinding && (
					<p className="text-muted-foreground/80 pt-0.5 text-xs leading-relaxed">
						{check.fix_hint}
					</p>
				)}
			</div>
			<div className="grow" />
			{isFinding && (
				<CategoryLink
					target={category}
					label="Fix"
					className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}
				/>
			)}
		</div>
	)
}

function CategoryCard({
	category,
	checks,
}: {
	category: Category
	checks: ReadonlyArray<V2SetupAuditCheck>
}) {
	const meta = CATEGORY[category]
	const findings = checks.filter((check) => check.status === "fail").length
	return (
		<div className="bg-card flex flex-col rounded-lg border">
			<div className="flex items-center gap-3 px-4 pt-4 pb-3">
				<h3 className="text-sm font-medium">{meta.label}</h3>
				<span className="text-muted-foreground font-mono text-[11px]">
					{findings > 0 ? `${findings} finding${findings === 1 ? "" : "s"}` : "clear"}
				</span>
				<div className="grow" />
				<CategoryLink
					target={meta}
					label={meta.fixLabel}
					className={buttonVariants({ variant: "ghost", size: "sm" })}
				/>
			</div>
			{checks.map((check) => (
				<CheckRow key={check.id} check={check} />
			))}
		</div>
	)
}

function Report({ audit }: { audit: V2SetupAudit }) {
	const [showPassing, setShowPassing] = useState(false)
	const refresh = useAtomRefresh(setupAuditAtom)

	const grouped = useMemo(() => {
		const visible = audit.checks.filter((check) => showPassing || check.status === "fail")
		const bySeverity = (a: V2SetupAuditCheck, b: V2SetupAuditCheck) =>
			SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
			a.id.localeCompare(b.id)
		return CATEGORY_ORDER.map((category) => ({
			category,
			checks: visible.filter((check) => check.category === category).sort(bySeverity),
		})).filter((group) => group.checks.length > 0)
	}, [audit.checks, showPassing])

	const { summary } = audit
	const findingCount = summary.critical + summary.warn + summary.info

	if (audit.data_status === "no_data") {
		return (
			<div className="bg-card flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
				<ServerIcon size={20} className="text-muted-foreground/60" />
				<div className="flex flex-col gap-1">
					<p className="text-sm font-medium">No telemetry yet</p>
					<p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
						The audit runs once your first service reports in. Connect one from the Ingestion tab
						and come back.
					</p>
				</div>
				<Link
					to="/settings"
					search={{ tab: "ingestion" }}
					className={buttonVariants({ variant: "outline", size: "sm" })}
				>
					Go to Ingestion
				</Link>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3">
				<SummaryPill count={summary.critical} label="critical" className="text-destructive" />
				<SummaryPill count={summary.warn} label="warning" className="text-warning" />
				<SummaryPill count={summary.info} label="info" className="text-info" />
				<span className="text-muted-foreground/40">·</span>
				<SummaryPill count={summary.pass} label="passing" className="text-success" />
				{summary.skip > 0 && (
					<SummaryPill count={summary.skip} label="skipped" className="text-muted-foreground" />
				)}
				<div className="grow" />
				<span className="text-muted-foreground/70 text-[11px]">
					{formatRelativeTime(audit.generated_at)}
				</span>
				<Button variant="ghost" size="sm" onClick={() => refresh()}>
					<ArrowRotateAnticlockwiseIcon size={14} />
					Re-run
				</Button>
			</div>

			{!audit.telemetry_checks_available && (
				<div className="border-warning/30 bg-warning/5 text-muted-foreground rounded-lg border px-4 py-3 text-xs leading-relaxed">
					<span className="text-foreground font-medium">Telemetry checks skipped.</span> Your
					warehouse could not be queried, so only configuration was audited. The findings below
					still apply.
				</div>
			)}

			{findingCount === 0 && !showPassing ? (
				<div className="bg-card flex flex-col items-center gap-2 rounded-lg border px-4 py-10 text-center">
					<CircleCheckIcon size={20} className="text-success" />
					<p className="text-sm font-medium">Everything checks out</p>
					<p className="text-muted-foreground text-xs">
						All {summary.pass} checks passed. Alerts can deliver, and your telemetry follows the
						conventions Maple reads.
					</p>
				</div>
			) : (
				grouped.map((group) => (
					<CategoryCard key={group.category} category={group.category} checks={group.checks} />
				))
			)}

			<button
				type="button"
				onClick={() => setShowPassing((value) => !value)}
				className="text-muted-foreground hover:text-foreground self-start text-xs transition-colors"
			>
				{showPassing
					? "Hide passing checks"
					: `Show ${summary.pass + summary.skip} passing and skipped checks`}
			</button>
		</div>
	)
}

export function SetupAuditSection() {
	const result = useAtomValue(setupAuditAtom)

	if (Result.isFailure(result)) {
		return (
			<div className="bg-card flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
				<CircleWarningIcon size={20} className="text-destructive" />
				<p className="text-sm font-medium">Could not run the audit</p>
				<p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
					Your workspace configuration could not be read. Try again in a moment.
				</p>
			</div>
		)
	}

	if (!Result.isSuccess(result)) {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-12 w-full rounded-lg" />
				<Skeleton className="h-48 w-full rounded-lg" />
			</div>
		)
	}

	return <Report audit={result.value} />
}
