import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M10 14V21H12",
	"M14 14V19",
	"M9 12L9 12.01",
	"M15 12L15 12.01",
	"M7 10L7 10.01",
	"M17 10L17 10.01",
	"M5 8L5 8.01",
	"M19 8L19 8.01",
	"M3 6V3H21V6",
]

function FilterIcon({ size = 24, className, ...props }: IconProps) {
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
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { FilterIcon }
