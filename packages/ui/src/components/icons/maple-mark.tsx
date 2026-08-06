import type { IconProps } from "./icon"

/**
 * The Maple tree mark — the brand glyph, not a UI icon.
 *
 * One evenodd path: the two eyes and the notch beside the trunk are knockouts,
 * so whatever sits behind reads through them. That is why `fillRule` is
 * load-bearing and why the mark takes a solid `currentColor` fill rather than a
 * gradient — a gradient shows through the eyes at a different value than at the
 * silhouette edge and they stop reading as eyes.
 *
 * The artwork is bottom-cropped: the trunk runs to the very bottom of the
 * viewBox. Optically centring it inside a square reads bottom-heavy, so the
 * tiled favicon variants seat it on a baseline instead (see
 * `apps/landing/public/favicon.svg`). In-app this renders bare, with no tile —
 * a tile is chrome the favicon needs to survive a browser tab strip, and inside
 * our own header it would just be a box around a box.
 */
function MapleMark({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 739 739"
			width={size}
			height={size}
			className={className}
			role="img"
			aria-label="Maple"
			{...props}
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				fill="currentColor"
				d="M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"
			/>
		</svg>
	)
}

export { MapleMark }
