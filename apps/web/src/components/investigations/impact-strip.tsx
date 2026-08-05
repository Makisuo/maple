import type { ReactNode } from "react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { getServiceColor } from "@maple/ui/lib/colors"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { placeholderBlastRadius } from "./fanout-placeholder"

/**
 * Four named lanes under the verdict. Three of them read fields that have been
 * on the wire the whole time and rendered nowhere — `report.affectedScope`, the
 * union of `evidence[].relatedServices`, and the snapshot's incident window.
 *
 * Fixed lane widths rather than `gap` alone: the lanes have to hold their
 * vertical rules in place as the rail widens and narrows, and a flex-only strip
 * re-wraps the moment the right panel opens.
 */
export function ImpactStrip({ investigation }: { investigation: V2Investigation }) {
	const { report, snapshot } = investigation
	const isSettled = investigation.status !== "investigating"

	const services = servicesTouched(investigation)
	const window = incidentWindow(snapshot)
	const blast = placeholderBlastRadius(investigation)

	return (
		<div className={STRIP}>
			<Lane label="Affected scope">
				<span className="text-foreground">
					{report?.affectedScope?.trim() || (isSettled ? "Not determined" : "Not yet determined")}
				</span>
			</Lane>
			<Lane label="Services touched">
				{services.length === 0 ? (
					<span className="text-muted-foreground">None recorded</span>
				) : (
					<span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
						{services.map((service) => (
							<span key={service} className="flex items-center gap-1.5">
								<span
									aria-hidden
									className="size-1.5 shrink-0 rounded-[3px]"
									style={{ backgroundColor: getServiceColor(service) }}
								/>
								<span className="text-foreground">{service}</span>
							</span>
						))}
					</span>
				)}
			</Lane>
			<Lane label="Incident window">
				<span className="text-foreground tabular-nums">{window}</span>
			</Lane>
			<Lane label="Blast radius">
				{/* Two nowrap groups rather than four flex children: as separate items
				    the "·" is free to wrap onto a line of its own, which it did. */}
				<span className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
					<span className="whitespace-nowrap">
						<span className="font-medium text-destructive tabular-nums">
							{formatNumber(blast.events)}
						</span>{" "}
						events
					</span>
					<span aria-hidden>·</span>
					<span className="whitespace-nowrap">
						<span className="font-medium text-foreground tabular-nums">
							{formatNumber(blast.users)}
						</span>{" "}
						users
					</span>
				</span>
			</Lane>
		</div>
	)
}

/**
 * A grid, not a flex row with divider elements between the lanes.
 *
 * Fixed lane widths plus standalone dividers only line up at one viewport: at the
 * real content width (≈830px once the sidebar and the rail take their share) the
 * last lane wrapped and left its divider stranded at the end of the row above.
 * Grid columns can't strand a separator because the separator *is* the cell's
 * left border, and the `nth-child` rules below clear it for whichever cell starts
 * a row at that breakpoint.
 */
const STRIP = [
	"grid shrink-0 gap-y-5 px-1",
	"grid-cols-2 xl:grid-cols-4",
	"[&>*]:border-l [&>*]:pl-6",
	// 2-up: every odd cell starts a row.
	"[&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0",
	// 4-up: only the first cell does, so the odd rule has to be undone.
	"xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6",
	"xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0",
].join(" ")

function Lane({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-border">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<div className="text-sm">{children}</div>
		</div>
	)
}

/**
 * Every distinct service any piece of evidence touched, in first-seen order.
 * Deduped — the same service usually appears on several findings, and printing
 * it three times says nothing.
 */
function servicesTouched(investigation: V2Investigation): ReadonlyArray<string> {
	const seen = new Set<string>()
	for (const evidence of investigation.report?.evidence ?? []) {
		for (const service of evidence.relatedServices) {
			const name = service.trim()
			if (name) seen.add(name)
		}
	}
	// The scope is a service name often enough to be worth falling back to, and a
	// lane reading "None recorded" on a diagnosed incident looks broken.
	if (seen.size === 0) {
		const scope = investigation.snapshot.scope?.trim()
		if (scope && !scope.includes(" ")) seen.add(scope)
	}
	return [...seen]
}

/** `14:02 → 14:26 · 24m`, or as much of it as the snapshot actually carries. */
function incidentWindow(snapshot: V2Investigation["snapshot"]): string {
	const startedAt = snapshot.incidentStartedAt
	if (!startedAt) return "Not recorded"
	const startMs = toEpochMs(startedAt)
	if (!Number.isFinite(startMs)) return "Not recorded"
	const start = clockTime(startMs)

	const endedAt = snapshot.incidentEndedAt
	if (!endedAt) return `${start} → ongoing`
	const endMs = toEpochMs(endedAt)
	if (!Number.isFinite(endMs) || endMs < startMs) return `${start} → ongoing`
	return `${start} → ${clockTime(endMs)} · ${formatDuration(endMs - startMs)}`
}

const clockTime = (epochMs: number) =>
	new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
