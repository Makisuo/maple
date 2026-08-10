import type { IconProps } from "./icon"

/**
 * An arc travelling a ring — the canvas's small-size loading mark.
 *
 * `LoaderIcon` is a twelve-spoke ring with graded opacity, which is a fine 24px
 * glyph and mush at the 11px the lens lanes draw it: twelve 2px spokes inside
 * eleven pixels overlap into a grey smudge that rotates, and a rotating smudge is
 * what makes a card look cheap. Two strokes survive that size — a dim full ring
 * and a bright quarter arc riding it.
 *
 * It is also the same idea as the live progress bar, one axis around instead of
 * along: a bright segment inside a dim track. The running lane wears both, and
 * they read as one thing rather than two unrelated animations.
 */
function SpinnerIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
			{/* A quarter turn, clockwise from twelve o'clock. Round caps: at 11px a square
			    cap is a full pixel of the arc's length and reads as a notch. */}
			<path d="M12 3A9 9 0 0 1 21 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
		</svg>
	)
}

export { SpinnerIcon }
