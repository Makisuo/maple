import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M5 16H6",
	"M18 16H19",
	"M8 14H16",
	"M3 18V21H21V18",
	"M10.5 3H13.5",
	"M10.5 10H13.5",
	"M15.5 5L15.5 8",
	"M8.5 5L8.5 8",
]

function UserIcon({ size = 24, className, ...props }: IconProps) {
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
export { UserIcon }
