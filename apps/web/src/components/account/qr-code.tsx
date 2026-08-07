import { useMemo } from "react"
import { encode } from "uqr"

/**
 * A QR code as a single `<path>` in `currentColor`, so it inherits the theme's foreground and
 * stays crisp at any size.
 *
 * `uqr` ships a `renderSVG()` that returns a markup string, which would mean
 * `dangerouslySetInnerHTML` and a hard-coded fill — encoding to the module matrix and drawing it
 * here avoids both.
 */
export function QrCode({ value, className }: { value: string; className?: string }) {
	const { size, path } = useMemo(() => {
		const result = encode(value, { border: 1 })
		// One 1×1 square per dark module. Merging them into a single path keeps this to one DOM
		// node instead of the ~700 a rect-per-module version would create.
		const path = result.data
			.flatMap((row, y) => row.map((isDark, x) => (isDark ? `M${x} ${y}h1v1h-1z` : "")))
			.join("")
		return { size: result.size, path }
	}, [value])

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={`0 0 ${size} ${size}`}
			className={className}
			shapeRendering="crispEdges"
			role="img"
			aria-label="Two-factor setup QR code"
		>
			<path d={path} fill="currentColor" />
		</svg>
	)
}
