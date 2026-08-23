import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 16.01V16",
	"M16 16.01V16",
	"M8 16.01V16",
	"M7 3H6",
	"M17 3H18",
	"M7 21H6",
	"M17 21H18",
	"M2 12H1",
	"M22 12H23",
	"M4 10V5",
	"M20 10V5",
	"M4 19V14",
	"M20 19V14",
]

function BracketsCurlyIcon({ size = 24, className, ...props }: IconProps) {
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
export { BracketsCurlyIcon }
