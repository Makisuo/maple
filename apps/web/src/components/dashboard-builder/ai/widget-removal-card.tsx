import { useMemo } from "react"
import { Atom, useAtom } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { CheckIcon, TrashIcon } from "@/components/icons"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

interface WidgetRemovalCardProps {
	input: { widgetTitle: string }
	widgets: DashboardWidget[]
	onConfirm: (widgetId: string) => void
}

function findWidgetByTitle(widgets: DashboardWidget[], title: string): DashboardWidget | null {
	const normalized = title.toLowerCase().trim()
	if (normalized.length === 0) return null
	return (
		widgets.find((w) => w.display.title?.toLowerCase().trim() === normalized) ??
		widgets.find((w) => w.display.title?.toLowerCase().includes(normalized)) ??
		null
	)
}

export function WidgetRemovalCard({ input, widgets, onConfirm }: WidgetRemovalCardProps) {
	const removedAtom = useMemo(() => Atom.make(false), [])
	const [removed, setRemoved] = useAtom(removedAtom)

	const matched = findWidgetByTitle(widgets, input.widgetTitle)

	const handleRemove = () => {
		if (removed || !matched) return
		onConfirm(matched.id)
		setRemoved(true)
	}

	return (
		<div className="my-2 overflow-hidden rounded-lg border border-destructive/30 bg-destructive/5 text-xs">
			<div className="flex items-center gap-3 px-3 py-2.5">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
					<TrashIcon className="size-4 text-destructive" />
				</div>
				<div className="min-w-0 flex-1">
					{matched ? (
						<>
							<p className="truncate font-medium text-foreground">
								Remove "{matched.display.title}"
							</p>
							<p className="text-muted-foreground">{matched.visualization} widget</p>
						</>
					) : (
						<p className="text-muted-foreground">
							No widget found matching "{input.widgetTitle}"
						</p>
					)}
				</div>
				{removed ? (
					<span className="flex items-center gap-1 text-severity-info">
						<CheckIcon className="size-3.5" />
						Removed
					</span>
				) : matched ? (
					<Button
						size="xs"
						variant="outline"
						onClick={handleRemove}
						className="border-destructive/40 text-destructive hover:bg-destructive/10"
					>
						Remove
					</Button>
				) : null}
			</div>
		</div>
	)
}
