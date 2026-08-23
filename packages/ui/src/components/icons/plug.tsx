import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M16 2V7",
	"M8 2V7",
	"M18 15.01V15",
	"M6 15.01V15",
	"M4 13V7H20V13",
	"M10 21H14",
	"M16 19V17",
	"M8 19V17",
]

function PlugIcon({ size = 24, className, ...props }: IconProps) {
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
export { PlugIcon }
