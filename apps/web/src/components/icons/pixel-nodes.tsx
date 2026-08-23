import type { IconProps } from "./icon"

function PixelNodesIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M11 2.00001H13"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M11 8.00001H13"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M15 4L15 6"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M9 4L9 6"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M19 14H21"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M3.00002 14H5.00002"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M19 20H21"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M3.00002 20H5.00002"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M23 16L23 18"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M7 16L7 18"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M17 16L17 18"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M1 16L1 18"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path d="M4.01003 10L4.00003 10" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20 10L20.01 10" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M10 21L10.01 21" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M14 21L14.01 21" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M12 22L12.01 22" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M5.01003 8L5.00003 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M19 8L19.01 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { PixelNodesIcon }
