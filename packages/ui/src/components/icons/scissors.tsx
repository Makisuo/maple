import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M14.01 15L14 15",
	"M10.01 15L10 15",
	"M17 21H19",
	"M5 21H7",
	"M17 14H19",
	"M5 14H7",
	"M15 16L15 19",
	"M3 16L3 19",
	"M21 16L21 19",
	"M9 16L9 19",
	"M14 9L14 10",
	"M12 12L12 13",
	"M10 9L10 10",
	"M8 6L8 7",
	"M6 3L6 4",
	"M16 6L16 7",
	"M18 3L18 4",
]

function ScissorsIcon({ size = 24, className, ...props }: IconProps) {
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
export { ScissorsIcon }
