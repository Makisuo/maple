import { useRef } from "react"
import { useReactFlow, useStoreApi } from "@xyflow/react"
import { useMountEffect } from "@/hooks/use-mount-effect"

/** React Flow camera controls without transform-driven React renders. */
export function ServiceMapControls() {
	const zoomInRef = useRef<HTMLButtonElement | null>(null)
	const zoomOutRef = useRef<HTMLButtonElement | null>(null)
	const flow = useReactFlow()
	const store = useStoreApi()

	useMountEffect(() => {
		const update = () => {
			const { transform, minZoom, maxZoom } = store.getState()
			if (zoomInRef.current) zoomInRef.current.disabled = transform[2] >= maxZoom
			if (zoomOutRef.current) zoomOutRef.current.disabled = transform[2] <= minZoom
		}
		update()
		return store.subscribe(update)
	})

	return (
		<div
			className="react-flow__panel react-flow__controls vertical bottom left"
			data-testid="rf__controls"
			aria-label="Control Panel"
		>
			<button
				ref={zoomInRef}
				type="button"
				className="react-flow__controls-button react-flow__controls-zoomin"
				title="Zoom In"
				aria-label="Zoom In"
				onClick={() => void flow.zoomIn()}
			>
				<svg viewBox="0 0 32 32" aria-hidden="true">
					<path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" />
				</svg>
			</button>
			<button
				ref={zoomOutRef}
				type="button"
				className="react-flow__controls-button react-flow__controls-zoomout"
				title="Zoom Out"
				aria-label="Zoom Out"
				onClick={() => void flow.zoomOut()}
			>
				<svg viewBox="0 0 32 5" aria-hidden="true">
					<path d="M0 0h32v4.2H0z" />
				</svg>
			</button>
			<button
				type="button"
				className="react-flow__controls-button react-flow__controls-fitview"
				title="Fit View"
				aria-label="Fit View"
				onClick={() => void flow.fitView()}
			>
				<svg viewBox="0 0 32 30" aria-hidden="true">
					<path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
				</svg>
			</button>
		</div>
	)
}
