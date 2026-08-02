import { cn } from "@maple/ui/utils"

/**
 * Canonical section heading — the small uppercase label that titles a group of
 * fields or a card's contents. The `id` is meant to be referenced by an
 * `aria-labelledby` on the group it heads.
 *
 * The default `mb-3` suits a heading stacked above its content; pass
 * `className="mb-0"` when the heading sits inline (e.g. in a flex row beside an
 * action button).
 */
export function SectionHeader({ id, label, className }: { id: string; label: string; className?: string }) {
	return (
		<h2
			id={id}
			className={cn(
				"mb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground",
				className,
			)}
		>
			{label}
		</h2>
	)
}
