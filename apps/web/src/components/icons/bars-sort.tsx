import type { IconProps } from "./icon"

// Three lines narrowing downward — the conventional "sort / ordered list" glyph.
// Also stands in as the empty-state mark for a filtered list that returned nothing.
const paths: ReadonlyArray<string> = ["M4 7H20", "M7 12H17", "M10 17H14"]

function BarsSortIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			aria-hidden="true"
			{...props}
		>
			{paths.map((d, i) => (
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			))}
		</svg>
	)
}
export { BarsSortIcon }
