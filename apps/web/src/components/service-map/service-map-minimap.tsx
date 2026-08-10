import { useRef } from "react"
import { useStoreApi } from "@xyflow/react"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { getServiceMapNodeColor, type ServiceMapColorMode, type ServiceNodeData } from "./service-map-utils"

const SVG_NS = "http://www.w3.org/2000/svg"
const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 150
const MINIMAP_OFFSET = 5

interface Bounds {
	x: number
	y: number
	width: number
	height: number
}

function unionBounds(first: Bounds, second: Bounds): Bounds {
	const x = Math.min(first.x, second.x)
	const y = Math.min(first.y, second.y)
	return {
		x,
		y,
		width: Math.max(first.x + first.width, second.x + second.width) - x,
		height: Math.max(first.y + first.height, second.y + second.height) - y,
	}
}

/**
 * Read-only service-map overview with an imperative camera mask.
 *
 * React Flow's stock MiniMap recomputes the bounds of every node inside its
 * transform selector, then commits React on every pan/zoom frame. The service
 * map can have hundreds of nodes, so this version rebuilds node geometry only
 * when the node array changes and updates the camera SVG directly.
 */
export function ServiceMapMiniMap({ colorMode }: { colorMode: ServiceMapColorMode }) {
	const rootRef = useRef<HTMLDivElement | null>(null)
	const svgRef = useRef<SVGSVGElement | null>(null)
	const nodesRef = useRef<SVGGElement | null>(null)
	const maskRef = useRef<SVGPathElement | null>(null)
	const store = useStoreApi()

	useMountEffect(() => {
		const root = rootRef.current
		const svg = svgRef.current
		const nodeGroup = nodesRef.current
		const mask = maskRef.current
		if (!root || !svg || !nodeGroup || !mask) return

		let previousNodes: ReturnType<typeof store.getState>["nodes"] | null = null
		let nodeBounds: Bounds | null = null
		let needsMeasurements = true

		const rebuildNodes = () => {
			const state = store.getState()
			const fragment = document.createDocumentFragment()
			let minX = Number.POSITIVE_INFINITY
			let minY = Number.POSITIVE_INFINITY
			let maxX = Number.NEGATIVE_INFINITY
			let maxY = Number.NEGATIVE_INFINITY
			needsMeasurements = false

			for (const node of state.nodes) {
				if (node.hidden || node.type === "namespaceGroup") continue
				const internal = state.nodeLookup.get(node.id)
				const userNode = internal?.internals.userNode ?? node
				const width = userNode.measured?.width ?? userNode.width ?? 0
				const height = userNode.measured?.height ?? userNode.height ?? 0
				if (width <= 0 || height <= 0) {
					needsMeasurements = true
					continue
				}
				const x = internal?.internals.positionAbsolute.x ?? node.position.x
				const y = internal?.internals.positionAbsolute.y ?? node.position.y
				minX = Math.min(minX, x)
				minY = Math.min(minY, y)
				maxX = Math.max(maxX, x + width)
				maxY = Math.max(maxY, y + height)

				const rect = document.createElementNS(SVG_NS, "rect")
				rect.setAttribute("x", String(x))
				rect.setAttribute("y", String(y))
				rect.setAttribute("width", String(width))
				rect.setAttribute("height", String(height))
				rect.setAttribute("rx", "5")
				rect.setAttribute("ry", "5")
				rect.setAttribute("fill", getServiceMapNodeColor(userNode.data as ServiceNodeData, colorMode))
				rect.setAttribute("shape-rendering", "crispEdges")
				fragment.append(rect)
			}

			nodeGroup.replaceChildren(fragment)
			nodeBounds = Number.isFinite(minX)
				? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
				: null
			previousNodes = state.nodes
		}

		const update = () => {
			const state = store.getState()
			if (state.nodes !== previousNodes || needsMeasurements) rebuildNodes()

			const [tx, ty, zoom] = state.transform
			const safeZoom = Math.max(zoom, 0.001)
			const viewBounds: Bounds = {
				x: -tx / safeZoom,
				y: -ty / safeZoom,
				width: state.width / safeZoom,
				height: state.height / safeZoom,
			}
			const contentBounds = nodeBounds ? unionBounds(nodeBounds, viewBounds) : viewBounds
			const scale = Math.max(
				contentBounds.width / MINIMAP_WIDTH,
				contentBounds.height / MINIMAP_HEIGHT,
				0.001,
			)
			const offset = MINIMAP_OFFSET * scale
			const viewWidth = scale * MINIMAP_WIDTH + offset * 2
			const viewHeight = scale * MINIMAP_HEIGHT + offset * 2
			const x = contentBounds.x - (viewWidth - contentBounds.width) / 2
			const y = contentBounds.y - (viewHeight - contentBounds.height) / 2

			svg.setAttribute("viewBox", `${x} ${y} ${viewWidth} ${viewHeight}`)
			mask.setAttribute(
				"d",
				`M${x},${y}h${viewWidth}v${viewHeight}h${-viewWidth}z M${viewBounds.x},${viewBounds.y}h${viewBounds.width}v${viewBounds.height}h${-viewBounds.width}z`,
			)
		}

		update()
		return store.subscribe(update)
	})

	return (
		<div
			ref={rootRef}
			className="react-flow__panel bottom right react-flow__minimap pointer-events-none !bg-muted/50 !border-border"
		>
			<svg
				ref={svgRef}
				width={MINIMAP_WIDTH}
				height={MINIMAP_HEIGHT}
				className="react-flow__minimap-svg"
				role="img"
				aria-label="Service map overview"
			>
				<g ref={nodesRef} />
				<path
					ref={maskRef}
					className="react-flow__minimap-mask"
					fill="oklch(0.15 0 0 / 0.8)"
					fillRule="evenodd"
				/>
			</svg>
		</div>
	)
}
