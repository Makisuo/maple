import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M16.01 4L16 4",
	"M20.01 13L20 13",
	"M20.01 18L20 18",
	"M13.01 13L13 13",
	"M13.01 20L13 20",
	"M4.01 14L4 14",
	"M4.01 4L4 4",
	"M7 18L2 18L2 16",
	"M6 2L14 2",
	"M15 11L18 11",
	"M15 22L22 22L22 20",
	"M22 15L22 16",
	"M11 15L11 18",
	"M2 6L2 12",
	"M18 6L18 7",
]

function MessagesIcon({ size = 24, className, ...props }: IconProps) {
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
export { MessagesIcon }
