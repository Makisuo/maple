import type { IconProps } from "./icon"

function TrashIcon({ size = 24, className, ...props }: IconProps) {
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
				d="m18.833,8l-.503,12.083c-.045,1.071-.926,1.917-1.998,1.917H7.668c-1.072,0-1.954-.845-1.998-1.917l-.503-12.083"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m10,4v-1c0-.552.448-1,1-1h2c.552,0,1,.448,1,1v1"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="10"
				y1="18"
				x2="10"
				y2="12"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="14"
				y1="18"
				x2="14"
				y2="12"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m5,4h14c1.104,0,2,.896,2,2v2H3v-2c0-1.104.896-2,2-2Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { TrashIcon }
