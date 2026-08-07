import { MapleMark } from "@maple/ui/components/icons"

/**
 * The `maple local` lockup — local mode's wordmark.
 *
 * Two faces on one baseline: `maple` in the display face with the tracking
 * closed, `local` in mono with it open. That tension is the whole mark. It is
 * why `local` needs no badge around it — the face already reads as a qualifier,
 * and a filled chip sitting 8px from a filled nav tab just reads as another tab.
 *
 * The glyph is the shared brand mark at 16px, unmodified. It is set 2px above
 * the wordmark's size on purpose: the artwork is bottom-cropped (the trunk runs
 * to the bottom of its viewBox), so at 16px against 14px text the crown lands at
 * cap height and the trunk lands on the baseline without any optical nudge.
 *
 * Spec: Paper file "Maple Logo" → artboard `08 — Maple Local / lockup`.
 */
function LocalLockup() {
	return (
		<span className="mr-3 flex shrink-0 items-center gap-1.5">
			<MapleMark size={16} className="shrink-0 text-primary" />
			<span className="font-display text-sm font-semibold tracking-[-0.01em]">maple</span>
			<span className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
				local
			</span>
		</span>
	)
}

export { LocalLockup }
