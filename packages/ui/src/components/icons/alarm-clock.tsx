import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 11L12 8",
	"M9 3L15 3",
	"M19.01 7L19 7",
	"M17.01 5L17 5",
	"M20.01 2L20 2",
	"M4.01 2L4 2",
	"M2.01 4L2 4",
	"M22.01 4L22 4",
	"M7 5L7 5.01",
	"M5 7L5 7.01",
	"M3 9L3 15",
	"M21 9L21 15",
	"M7.01 19L7 19",
	"M5.01 17L5 17",
	"M17.01 19L17 19",
	"M19.01 17L19 17",
	"M21.01 19L21 19",
	"M16.01 14L16 14",
	"M14.01 13L14 13",
	"M3.01 19L3 19",
	"M2.01 21L2 21",
	"M22.01 21L22 21",
	"M9 21L15 21",
]

function AlarmClockIcon({ size = 24, className, ...props }: IconProps) {
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
export { AlarmClockIcon }
