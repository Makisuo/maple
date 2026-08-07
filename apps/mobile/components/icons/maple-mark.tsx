import Svg, { Path } from "react-native-svg"
import { colors } from "../../lib/theme"

interface IconProps {
	size?: number
	color?: string
}

/**
 * The Maple tree mark — the brand glyph, not a UI icon.
 *
 * A react-native-svg twin of `@maple/ui/components/icons/maple-mark`; the path
 * data is the same artwork, kept in sync by hand because RN cannot render the
 * DOM component. `fillRule="evenodd"` is load-bearing: the two eyes and the
 * notch beside the trunk are knockouts, so without it they fill in solid.
 */
export function MapleMark({ size = 24, color = colors.primary }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 739 739">
			<Path
				fillRule="evenodd"
				fill={color}
				d="M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"
			/>
		</Svg>
	)
}
