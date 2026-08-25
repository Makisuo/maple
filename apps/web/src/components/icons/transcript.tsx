import type { IconProps } from "./icon"

/** Staggered lines — a conversation read as a document, for the Transcript view. */
function TranscriptIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M4 5.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M4 10.5h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M9 15.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M9 20.5h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	)
}
export { TranscriptIcon }
