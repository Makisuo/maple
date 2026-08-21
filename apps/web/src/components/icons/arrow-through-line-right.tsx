import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M20 10L20 14",
	"M12 2L12 12",
	"M2 12L22 12",
	"M12 16L12 22",
	"M18 16L18.01 16",
	"M18 8L18.01 8",
]

function ArrowThroughLineRightIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowThroughLineRightIcon }
