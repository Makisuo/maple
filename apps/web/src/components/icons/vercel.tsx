import type { IconProps } from "./icon"

function VercelIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<path d="M24 22.525H0l12-21.05 12 21.05z" />
		</svg>
	)
}
export { VercelIcon }
