/**
 * One proposed action, opened out.
 *
 * The canvas prints an action clamped to two lines, which on a real report is
 * often less than the sentence — and there was nowhere to go from there. This is
 * that "somewhere": the full text, what shape of work it is, and the diagnosis
 * that produced it.
 *
 * What it deliberately does *not* claim: the API returns proposed actions as bare
 * strings (`suggestedActions: Array<string>`), with no per-action rationale or
 * evidence anywhere in the stack. So the cause, the confidence and the evidence
 * below are labelled as backing the *diagnosis*, not this one action. Presenting
 * report-level evidence as the reason for a specific action would be inventing a
 * link the data does not carry.
 */
import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetPanel,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { cn } from "@maple/ui/lib/utils"

import { ArrowRightIcon } from "@/components/icons"
import { CONFIDENCE_TONE } from "./confidence-meter"
import { ACTION_GLYPH } from "./flow/flow-nodes"
import type { ActionKind, ActionTarget } from "./flow/action-target"

export interface ProposedAction {
	/** Zero-based index into `report.suggestedActions` — the panel's identity and its URL key. */
	readonly index: number
	readonly text: string
	readonly kind: ActionKind
	readonly target: ActionTarget | null
	/** The roadmap chip the canvas node carries, repeated here so the two agree. */
	readonly promise: string
}

export interface ActionEvidenceItem {
	readonly note: string
	readonly traceIds: ReadonlyArray<string>
	readonly logPatterns: ReadonlyArray<string>
}

/**
 * Typed structurally rather than against `V2AiTriageResult` or `AiTriageResult`,
 * because both surfaces hold a different one of those two and the four fields
 * this needs are identical across them.
 */
export interface ActionReportContext {
	readonly suspectedCause: string
	readonly confidence: string
	readonly affectedScope: string
	readonly evidence: ReadonlyArray<ActionEvidenceItem>
}

const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"

/**
 * Trace ids and log patterns as chips. Lifted out of the diagnosis report card so
 * the investigation panel and the chat card render evidence identically.
 */
export function EvidenceChips({ item }: { item: ActionEvidenceItem }) {
	if (item.traceIds.length === 0 && item.logPatterns.length === 0) return null
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{item.traceIds.map((traceId) => (
				<Link
					key={traceId}
					to="/traces/$traceId"
					params={{ traceId }}
					className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-muted/70"
				>
					{traceId.slice(0, 12)}…
				</Link>
			))}
			{item.logPatterns.map((pattern) => (
				<span
					key={pattern}
					className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
				>
					{pattern}
				</span>
			))}
		</div>
	)
}

export function ActionDetailSheet({
	action,
	report,
	open,
	onOpenChange,
}: {
	action: ProposedAction | null
	report: ActionReportContext | null | undefined
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	// The sheet animates out, so it still renders for a beat after the action is
	// cleared. Holding the last action would need a ref and buys a frame; rendering
	// nothing inside a closing panel is not visible.
	const glyph = action ? ACTION_GLYPH[action.kind] : null
	const evidence =
		report?.evidence.filter((item) => item.note || item.traceIds.length || item.logPatterns.length) ?? []

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="sm:max-w-lg">
				{action && glyph ? (
					<>
						<SheetHeader>
							<div className="flex items-center gap-2">
								<glyph.Icon size={12} className="shrink-0 text-muted-foreground" />
								<span className={EYEBROW}>
									Proposed action {String(action.index + 1).padStart(2, "0")}
								</span>
								<span className="text-muted-foreground/40">·</span>
								<span className={EYEBROW}>{glyph.label}</span>
							</div>
							{/*
							 * The whole sentence, unclamped — this is the thing the canvas
							 * node cannot show and the reason this panel exists.
							 */}
							<SheetTitle className="text-base leading-snug">{action.text}</SheetTitle>
							<SheetDescription className="sr-only">
								What this proposed action asks for, and the diagnosis behind it.
							</SheetDescription>
						</SheetHeader>
						<SheetPanel className="flex flex-col gap-6">
							<div className="flex flex-wrap items-center gap-2">
								{action.target ? (
									<Button
										size="sm"
										render={<Link to={action.target.href} />}
										className="gap-1.5"
									>
										{action.target.label}
										<ArrowRightIcon size={13} />
									</Button>
								) : null}
								{/*
								 * The same roadmap promise the node carries. Rendered as a dead
								 * chip, not a disabled button: a button implies it will work
								 * once something is enabled, and there is nothing to enable.
								 */}
								<span className="rounded border border-dashed px-2 py-1 text-[10px] tracking-[0.06em] text-muted-foreground/70">
									{action.promise}
								</span>
							</div>

							{report ? (
								<section className="flex flex-col gap-2">
									<h3 className={EYEBROW}>From the diagnosis</h3>
									<p className="text-sm leading-relaxed text-foreground">
										{report.suspectedCause}
									</p>
									<p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
										<span
											className={cn(
												"font-medium capitalize",
												CONFIDENCE_TONE[report.confidence],
											)}
										>
											{report.confidence} confidence
										</span>
										{report.affectedScope ? (
											<>
												<span className="text-muted-foreground/40">·</span>
												<span>{report.affectedScope}</span>
											</>
										) : null}
									</p>
								</section>
							) : null}

							{evidence.length > 0 ? (
								<section className="flex flex-col gap-2">
									<h3 className={EYEBROW}>Evidence behind the diagnosis</h3>
									{evidence.map((item, index) => (
										<div
											key={index}
											className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
										>
											{item.note ? (
												<p className="text-sm leading-relaxed text-foreground">
													{item.note}
												</p>
											) : null}
											<EvidenceChips item={item} />
										</div>
									))}
								</section>
							) : null}
						</SheetPanel>
					</>
				) : (
					// Base UI requires a labelled popup even mid-close.
					<SheetHeader>
						<SheetTitle className="sr-only">Proposed action</SheetTitle>
					</SheetHeader>
				)}
			</SheetContent>
		</Sheet>
	)
}
