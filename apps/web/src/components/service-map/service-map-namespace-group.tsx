import { memo } from "react"
import { MinimizeIcon } from "@/components/icons"

export interface NamespaceGroupData {
	/** The `service.namespace` value used as the box label. */
	label: string
	/** Hue (0–360) derived from the namespace for tinting the box + label. */
	hue: number
	/** Collapse this namespace into a single aggregate node. */
	onCollapse?: () => void
	[key: string]: unknown
}

interface NamespaceGroupNodeProps {
	data: NamespaceGroupData
}

/**
 * Background node that wraps all services sharing a `service.namespace` in a
 * labeled dotted box. Non-interactive — `pointer-events: none` lets clicks,
 * drags, and panning pass straight through to the service nodes and the pane —
 * EXCEPT the label chip, which re-enables pointer events to host the collapse
 * button. Sized by the `style.width/height` set on the node in the view.
 */
export const NamespaceGroupNode = memo(function NamespaceGroupNode({ data }: NamespaceGroupNodeProps) {
	const { label, hue, onCollapse } = data
	const borderColor = `oklch(0.66 0.12 ${hue} / 0.7)`
	const bgColor = `oklch(0.62 0.11 ${hue} / 0.05)`
	const labelColor = `oklch(0.82 0.12 ${hue})`
	const chipBg = `oklch(0.24 0.04 ${hue} / 0.92)`
	const chipBorder = `oklch(0.66 0.12 ${hue} / 0.4)`

	return (
		<div
			className="pointer-events-none h-full w-full rounded-xl border-[1.5px] border-dashed"
			style={{ borderColor, backgroundColor: bgColor }}
		>
			<span
				className="pointer-events-auto absolute left-2.5 top-2 flex max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
				style={{ color: labelColor, backgroundColor: chipBg, borderColor: chipBorder }}
			>
				<span className="truncate">{label}</span>
				{onCollapse ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation()
							onCollapse()
						}}
						title={`Collapse ${label} into one node`}
						className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
					>
						<MinimizeIcon size={10} />
					</button>
				) : null}
			</span>
		</div>
	)
})
