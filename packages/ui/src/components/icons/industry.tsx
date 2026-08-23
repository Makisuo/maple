import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 21H21V12",
	"M17 2H8",
	"M19 14.01V14",
	"M11 16.01V16",
	"M17 16.01V16",
	"M19 4.01V4",
	"M6 10H8V21H3V16",
	"M4 12V14",
	"M17 6H10",
	"M15 12V14H13",
	"M6 6L6 4",
]

function IndustryIcon({ size = 24, className, ...props }: IconProps) {
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
export { IndustryIcon }
