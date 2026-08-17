import type { ComponentType } from "react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { BellIcon, CircleQuestionIcon, CircleWarningIcon, PulseIcon, UserIcon } from "@/components/icons"
import { investigationKindKey, type InvestigationKindKey } from "./investigation-display"

type InvestigationStatus = V2Investigation["status"]

/**
 * One vocabulary for an investigation's lifecycle, shaped like the issues
 * surface's `SeverityBadge` so the two read as the same system. The wire values
 * are lowercase enum tokens (`investigating`), which is not what a person calls
 * them — the label map is the whole point of this component existing.
 */
const STATUS: Record<InvestigationStatus, { label: string; tone: string }> = {
	investigating: { label: "In progress", tone: "bg-primary/10 text-primary" },
	diagnosed: { label: "Diagnosed", tone: "bg-success/10 text-success" },
	// Warn, not destructive. The run worked and reached "not established"; the
	// destructive tone belongs to `failed`, where the machinery actually broke,
	// and using it here is what made every honest partial read as a defect.
	inconclusive: { label: "Inconclusive", tone: "bg-severity-warn/10 text-severity-warn" },
	resolved: { label: "Resolved", tone: "bg-muted text-muted-foreground" },
	failed: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
} satisfies Record<InvestigationStatus, { label: string; tone: string }>

export function InvestigationStatusBadge({
	status,
	className,
}: {
	status: InvestigationStatus
	className?: string
}) {
	return (
		<Badge variant="outline" className={cn(STATUS[status].tone, className)}>
			{STATUS[status].label}
		</Badge>
	)
}

/**
 * How an investigation was started. Kept to one word: it sits in a table column
 * headed "Origin", where a sentence just truncates.
 */
const ORIGIN: Record<V2Investigation["seeded_by"], string> = {
	user: "Manual",
	system: "Automatic",
} satisfies Record<V2Investigation["seeded_by"], string>

export const investigationOriginLabel = (seededBy: V2Investigation["seeded_by"]): string => ORIGIN[seededBy]

/** What is being investigated. `freeform` is a question, not a kind of incident. */
const KIND_LABEL: Record<InvestigationKindKey, string> = {
	alert: "Alert",
	anomaly: "Anomaly",
	error: "Error",
	question: "Question",
} satisfies Record<InvestigationKindKey, string>

export const investigationKindLabel = (subject: V2Investigation["subject"]): string =>
	KIND_LABEL[investigationKindKey(subject)]

const KIND_ICON: Record<InvestigationKindKey, ComponentType<{ className?: string }>> = {
	alert: BellIcon,
	anomaly: PulseIcon,
	error: CircleWarningIcon,
	question: CircleQuestionIcon,
} satisfies Record<InvestigationKindKey, ComponentType<{ className?: string }>>

/**
 * Kind and origin, in the width one column used to take for each. Origin is
 * only drawn when it is `user`: every automatic row printing the same word is
 * not information, but a human having stepped in is. Both are spelled out in
 * the label so the marker is never the only place they exist.
 */
export function InvestigationKindMarker({
	subject,
	seededBy,
	className,
}: {
	subject: V2Investigation["subject"]
	seededBy: V2Investigation["seeded_by"]
	className?: string
}) {
	const kind = investigationKindKey(subject)
	const Icon = KIND_ICON[kind]
	const label = `${KIND_LABEL[kind]} · started ${seededBy === "user" ? "manually" : "automatically"}`
	return (
		<span
			className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", className)}
			title={label}
		>
			<span className="sr-only">{label}</span>
			<Icon className="size-3.5" />
			{seededBy === "user" ? <UserIcon className="size-3" /> : null}
		</span>
	)
}
