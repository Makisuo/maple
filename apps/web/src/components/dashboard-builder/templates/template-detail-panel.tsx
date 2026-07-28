import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { cn } from "@maple/ui/utils"
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon } from "@/components/icons"
import { templateIcon } from "./template-icons"
import { TemplateLivePreview } from "./template-live-preview"
import {
	CATEGORY_LABELS,
	compositionLabel,
	relativeAge,
	setupDestination,
	widgetCountLabel,
} from "./template-summary"
import { READINESS_WINDOW_LABEL, type TemplateReadiness } from "./use-template-readiness"

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<span className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
			{children}
		</span>
	)
}

/**
 * What the org needs before the widgets fill in. Both halves come from the
 * template's structured requirement — the mono prefix is the thing the
 * readiness check literally tests, the sentence names what emits it.
 */
function RequirementBlock({
	template,
	readiness,
}: {
	template: V2DashboardTemplate
	readiness: TemplateReadiness | undefined
}) {
	const requirement = template.requirement
	if (!requirement) return null

	const ready = readiness?.ready !== false
	const age = relativeAge(readiness?.lastSeen ?? null, Date.now())

	return (
		<div className="flex flex-col gap-2.5">
			<SectionLabel>What it needs</SectionLabel>
			<div className="flex items-start gap-2.5">
				{ready ? (
					<span className="bg-success flex size-4 shrink-0 items-center justify-center rounded-[3px]">
						<CheckIcon size={10} className="text-background" />
					</span>
				) : (
					<span className="border-input size-4 shrink-0 rounded-full border-[1.5px]" />
				)}
				<div className="flex min-w-0 grow flex-col gap-1">
					<div className="flex flex-wrap items-baseline gap-2.5">
						{readiness?.prefixLabel && (
							<span
								className={cn(
									"font-mono text-sm",
									ready ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{readiness.prefixLabel}
							</span>
						)}
						<span className={cn("text-sm", ready ? "text-foreground" : "text-muted-foreground")}>
							{ready
								? requirement.kind === "telemetry"
									? "trace data is arriving"
									: "metrics are arriving"
								: requirement.kind === "integration"
									? "not connected"
									: `no matching metrics in ${READINESS_WINDOW_LABEL}`}
						</span>
						{requirement.kind === "metrics" && readiness !== undefined && (
							<span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">
								{readiness.metricCount} {readiness.metricCount === 1 ? "metric" : "metrics"}
								{age !== null && ` · last seen ${age}`}
							</span>
						)}
					</div>
					<p className="text-muted-foreground text-[11px]">
						{ready ? "Collected by" : "Emitted by"} {requirement.collector}.
						{!ready && requirement.hint ? ` ${requirement.hint}` : ""}
					</p>
				</div>
			</div>
		</div>
	)
}

interface TemplateDetailPanelProps {
	template: V2DashboardTemplate
	readiness: TemplateReadiness | undefined
	creating: boolean
	onCreate: (parameters: Record<string, string>) => void
}

export function TemplateDetailPanel({ template, readiness, creating, onCreate }: TemplateDetailPanelProps) {
	// Keyed by template at the call site, so switching templates resets these
	// rather than carrying one template's service name into the next.
	const [values, setValues] = useState<Record<string, string>>({})

	const Icon = templateIcon(template.id, template.category)
	const ready = readiness?.ready !== false
	const composition = compositionLabel(template.preview)
	const destination = useMemo(() => setupDestination(template), [template])

	const missingRequired = template.parameters
		.filter((parameter) => parameter.required && !(values[parameter.key] ?? "").trim())
		.map((parameter) => parameter.label)

	const submit = () => {
		if (creating || missingRequired.length > 0) return
		const filled = Object.fromEntries(
			Object.entries(values)
				.map(([key, value]) => [key, value.trim()] as const)
				.filter(([, value]) => value.length > 0),
		)
		onCreate(filled)
	}

	return (
		<div className="flex flex-col gap-6 p-8">
			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-3">
					<span className="border-border bg-card flex size-8.5 shrink-0 items-center justify-center rounded-lg border">
						<Icon size={17} />
					</span>
					<div className="flex min-w-0 flex-col gap-1">
						<h2 className="text-lg font-semibold tracking-tight">{template.name}</h2>
						<div className="text-muted-foreground flex items-center gap-2 text-[11px]">
							<span>{CATEGORY_LABELS[template.category] ?? template.category}</span>
							<span className="text-border">/</span>
							<span className="font-mono">
								{widgetCountLabel(template)}
								{composition && ` · ${composition}`}
							</span>
						</div>
					</div>
				</div>
				<p className="text-muted-foreground max-w-140 text-sm leading-relaxed">
					{template.description}
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<TemplateLivePreview template={template} parameters={values} />
				<p className="text-muted-foreground/85 text-[11px]">
					That's the dashboard you'd get right now.
				</p>
			</div>

			<RequirementBlock template={template} readiness={readiness} />

			{template.parameters.length > 0 && (
				<div className="flex flex-col gap-2.5">
					<SectionLabel>Parameters</SectionLabel>
					<div className="flex max-w-95 flex-col gap-4">
						{template.parameters.map((parameter) => (
							<div key={parameter.key} className="flex flex-col gap-1.75">
								<div className="flex items-baseline gap-2">
									<Label htmlFor={`template-param-${parameter.key}`}>
										{parameter.label}
									</Label>
									<span className="text-muted-foreground text-[11px]">
										{parameter.required ? "required" : "optional"}
									</span>
								</div>
								<Input
									id={`template-param-${parameter.key}`}
									value={values[parameter.key] ?? ""}
									placeholder={parameter.placeholder}
									onChange={(event) =>
										setValues((current) => ({
											...current,
											[parameter.key]: event.target.value,
										}))
									}
									onKeyDown={(event) => {
										if (event.key === "Enter") submit()
									}}
								/>
								{parameter.description && (
									<p className="text-muted-foreground text-[11px]">
										{parameter.description}
									</p>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Never blocking: a gated template can still be created, and its widgets
			    fill in on their own once the data starts arriving. */}
			<div className="flex flex-col gap-2.5 pt-1.5">
				<div className="flex flex-wrap items-center gap-2.5">
					{ready ? (
						<Button onClick={submit} disabled={missingRequired.length > 0} loading={creating}>
							Create dashboard
							<ArrowRightIcon size={13} data-icon="inline-end" />
						</Button>
					) : (
						<>
							<Button render={<Link to={destination.to} search={destination.search} />}>
								Set up {template.requirement?.setupLabel ?? "the collector"}
								<ExternalLinkIcon size={13} data-icon="inline-end" />
							</Button>
							<Button
								variant="outline"
								onClick={submit}
								disabled={missingRequired.length > 0}
								loading={creating}
							>
								Create it anyway
							</Button>
						</>
					)}
				</div>
				<p className="text-muted-foreground text-[11px]">
					{missingRequired.length > 0
						? `Fill in ${missingRequired.join(" and ")} first.`
						: ready
							? "Creates a copy you own — edit or delete it freely."
							: `Creating it now is fine — the widgets stay empty until the data shows up, then fill in on their own.`}
				</p>
			</div>
		</div>
	)
}
