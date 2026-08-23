import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M9 20H9.01",
	"M15 20H15.01",
	"M16 4H16.01",
	"M8 4H8.01",
	"M11 22H13",
	"M10 2H14",
	"M21 16L21 14",
	"M3 16L3 14",
	"M18 5.99999L18 12L19 12",
	"M6 6L6 12L5 12",
	"M5 18H19",
]

function BellIcon({ size = 24, className, ...props }: IconProps) {
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
export { BellIcon }
