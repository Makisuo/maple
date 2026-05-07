import { Badge } from "@maple/ui/components/ui/badge"
import { autoContextLabel, type AutoContext } from "./auto-contexts"

interface PageContextChipsProps {
	contexts: AutoContext[]
	onDismiss: (id: string) => void
}

export function PageContextChips({ contexts, onDismiss }: PageContextChipsProps) {
	if (contexts.length === 0) return null
	return (
		<div className="mb-2 flex flex-wrap items-center gap-1.5">
			{contexts.map((ctx) => (
				<Badge key={ctx.id} variant="outline" className="gap-1.5 pr-1">
					<span>{autoContextLabel(ctx)}</span>
					<button
						type="button"
						aria-label={`Remove ${autoContextLabel(ctx)}`}
						onClick={() => onDismiss(ctx.id)}
						className="rounded-sm px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						×
					</button>
				</Badge>
			))}
		</div>
	)
}
