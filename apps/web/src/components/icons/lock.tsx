import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M16 10V6C16 3.79086 14.2091 2 12 2C9.79086 2 8 3.79086 8 6V10",
	"M3 10H21V21H3V10Z",
	"M12 15V16",
]

function LockIcon({ size = 24, className, ...props }: IconProps) {
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
export { LockIcon }
