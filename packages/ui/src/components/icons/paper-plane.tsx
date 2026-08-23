import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M18 3L21 3L21 6",
	"M19 8L19 11",
	"M16 5L13 5",
	"M11 7L8 7",
	"M9 13L5 13",
	"M6 9L3 9L3 11",
	"M17 13L17 16",
	"M11 15L11 19",
	"M15 18L15 21H13",
]

function PaperPlaneIcon({ size = 24, className, ...props }: IconProps) {
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
export { PaperPlaneIcon }
