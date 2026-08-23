import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M14 12L10 12",
	"M21 12L21 19",
	"M22 5L22 6",
	"M2 5L2 6",
	"M3 12L3 19",
	"M19 21L5 21",
	"M20 3L4 3",
	"M20 8L4 8",
]

function BoxArchiveIcon({ size = 24, className, ...props }: IconProps) {
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
export { BoxArchiveIcon }
