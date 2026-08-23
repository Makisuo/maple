import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M19 21H5",
	"M19 3H5",
	"M3 19L3 5",
	"M21 19L21 5",
	"M17 11V9",
	"M7 13L7 15",
	"M15 7L13 7",
	"M9 17L11 17",
]

function AspectRatioIcon({ size = 24, className, ...props }: IconProps) {
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
export { AspectRatioIcon }
