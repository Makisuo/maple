import type { IconProps } from "./icon"

/** One thread splitting into two — the transcript's parallel-lane marker. */
function BranchForkIcon({ size = 24, className, ...props }: IconProps) {
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
			<path
				d="M7 21V13c0-2.2 1.8-4 4-4h6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path d="M7 11V3" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<circle cx="7" cy="21" r="2" stroke="currentColor" strokeWidth="2" />
			<circle cx="19" cy="9" r="2" stroke="currentColor" strokeWidth="2" />
			<circle cx="7" cy="3" r="2" stroke="currentColor" strokeWidth="2" />
		</svg>
	)
}
export { BranchForkIcon }
