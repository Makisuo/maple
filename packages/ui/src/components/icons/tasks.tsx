import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M17 5L17 7",
	"M9 21L19 21",
	"M5 17L7 17",
	"M13 16H13.01",
	"M15 14H15.01",
	"M11 14H11.01",
	"M17 12H17.01",
	"M21 9L21 19",
	"M7 9L7 19",
	"M9 7L19 7",
	"M3 5L3 15",
	"M5 3L15 3",
]

function TasksIcon({ size = 24, className, ...props }: IconProps) {
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
export { TasksIcon }
