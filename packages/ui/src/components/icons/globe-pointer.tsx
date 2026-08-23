import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M21 11H3",
	"M15 19L15 15L19 15",
	"M21.01 21H21",
	"M23.01 23H23",
	"M21 17H23V19",
	"M17 21V23H19",
	"M9 2L15 2",
	"M9 20L11 20",
	"M3 14V8",
	"M21 11V8",
	"M7.01 4L7 4",
	"M7.01 18L7 18",
	"M17.01 4L17 4",
	"M19.01 6L19 6",
	"M5.01 6L5 6",
	"M10.01 6L10 6",
	"M14.01 6L14 6",
	"M10.01 16L10 16",
	"M12.01 4L12 4",
	"M5.01 16L5 16",
	"M8 8V14",
	"M16 8V10",
]

function GlobePointerIcon({ size = 24, className, ...props }: IconProps) {
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
export { GlobePointerIcon }
