import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M6 21H18",
	"M22 16V13H2V16",
	"M20 19.01V18",
	"M4 19.01V18",
	"M4 9.00999V5",
	"M6 3L9.00999 3",
	"M11 5H11.01",
	"M18 7H13",
	"M20 9H20.01",
]

function FolderOpenIcon({ size = 24, className, ...props }: IconProps) {
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
export { FolderOpenIcon }
