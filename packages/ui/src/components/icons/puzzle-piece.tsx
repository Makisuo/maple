import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M6 21H9V20",
	"M6 4H9V5",
	"M11 18H13",
	"M11 7H13",
	"M18 21H15V20",
	"M18 4H15V5",
	"M4 19L4 16L3 16",
	"M20 19L20 16L21 16",
	"M1 14L1 11",
	"M23 14L23 11",
	"M4 6L4 9L3 9",
	"M20 6L20 9L21 9",
]

function PuzzlePieceIcon({ size = 24, className, ...props }: IconProps) {
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
export { PuzzlePieceIcon }
