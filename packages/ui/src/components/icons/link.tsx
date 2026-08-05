import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"m19.014 11.943 1.021 1.021c1.953 1.953 1.953 5.118 0 7.071-1.953 1.953-5.118 1.953-7.071 0l-3.121-3.121c-1.953-1.953-1.953-5.118 0-7.071.366-.366.775-.664 1.21-.892",
	"m12.934 15.056c.44-.23.853-.529 1.223-.899 1.953-1.953 1.953-5.118 0-7.071l-3.121-3.121c-1.953-1.953-5.118-1.953-7.071 0-1.953 1.953-1.953 5.118 0 7.071l1.021 1.021",
]

function LinkIcon({ size = 24, className, ...props }: IconProps) {
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
export { LinkIcon }
