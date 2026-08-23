import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M13 5H13.01",
	"M15 7H15.01",
	"M17 9H17.01",
	"M19 11H19.01",
	"M17 13H17.01",
	"M17 20H17.01",
	"M4 7H4.01",
	"M15 15H15.01",
	"M9 9H9.01",
	"M11 15H11.01",
	"M9 13H9.01",
	"M11 7H11.01",
	"M15 3H21V9",
	"M19 15V18",
	"M9 5L6 5",
	"M13 17V22H15",
	"M7 11L2 11L2 9",
	"M5 16H6",
	"M8 19L8 18",
	"M3 18V21H6",
]

function RocketIcon({ size = 24, className, ...props }: IconProps) {
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
export { RocketIcon }
