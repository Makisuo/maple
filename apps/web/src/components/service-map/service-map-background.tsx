import { useRef } from "react"
import { useStoreApi } from "@xyflow/react"
import { useMountEffect } from "@/hooks/use-mount-effect"

const GAP = 16
const DOT_SIZE = 1
const PATTERN_ID = "service-map-dot-pattern"

/** React Flow's dotted background with transform updates kept outside React. */
export function ServiceMapBackground() {
	const patternRef = useRef<SVGPatternElement | null>(null)
	const dotRef = useRef<SVGCircleElement | null>(null)
	const store = useStoreApi()

	useMountEffect(() => {
		const pattern = patternRef.current
		const dot = dotRef.current
		if (!pattern || !dot) return

		const update = () => {
			const [tx, ty, zoom] = store.getState().transform
			const scaledGap = GAP * zoom || 1
			const radius = (DOT_SIZE * zoom) / 2
			const offset = 1 + scaledGap / 2
			pattern.setAttribute("x", String(tx % scaledGap))
			pattern.setAttribute("y", String(ty % scaledGap))
			pattern.setAttribute("width", String(scaledGap))
			pattern.setAttribute("height", String(scaledGap))
			pattern.setAttribute("patternTransform", `translate(-${offset},-${offset})`)
			dot.setAttribute("cx", String(radius))
			dot.setAttribute("cy", String(radius))
			dot.setAttribute("r", String(radius))
		}

		update()
		return store.subscribe(update)
	})

	return (
		<svg
			className="react-flow__background"
			data-testid="rf__background"
			style={{ position: "absolute", width: "100%", height: "100%", inset: 0 }}
			aria-hidden="true"
		>
			<pattern ref={patternRef} id={PATTERN_ID} patternUnits="userSpaceOnUse">
				<circle ref={dotRef} className="react-flow__background-pattern dots" />
			</pattern>
			<rect x="0" y="0" width="100%" height="100%" fill={`url(#${PATTERN_ID})`} />
		</svg>
	)
}
