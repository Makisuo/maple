import * as React from "react"

export interface ContainerSize {
	width: number
	height: number
}

/**
 * Tracks the size of a container element using ResizeObserver.
 * On React Native, replace with an onLayout-based implementation.
 */
export function useContainerSize(ref: React.RefObject<HTMLElement | null>): ContainerSize {
	const [size, setSize] = React.useState<ContainerSize>({ width: 0, height: 0 })

	React.useEffect(() => {
		const el = ref.current
		if (!el) return

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setSize({
					width: entry.contentRect.width,
					height: entry.contentRect.height,
				})
			}
		})

		observer.observe(el)
		return () => observer.disconnect()
	}, [ref])

	return size
}
