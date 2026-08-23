import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M5 21H19",
	"M12 16L12 14",
	"M14 12L16 12",
	"M8 12L10 12",
	"M12 10L12 8",
	"M21 5L21 19",
	"M3 5L3 19",
	"M5 3H19",
]

function SquarePlusIcon({ size = 24, className, ...props }: IconProps) {
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
export { SquarePlusIcon }
