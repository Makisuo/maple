import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 3V9",
	"M3 9H21",
	"M17 17L15 17",
	"M5 21H19",
	"M6 3H18",
	"M3 19V9",
	"M21 19V9",
	"M20 7L20 7.01",
	"M4 7L4 7.01",
	"M5 5L5 5.01",
	"M19 5L19 5.01",
]

function BoxIcon({ size = 24, className, ...props }: IconProps) {
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
export { BoxIcon }
