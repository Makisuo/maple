import type { IconProps } from "./icon"

function RocketIcon({ size = 24, className, ...props }: IconProps) {
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
				d="m10.00,7h-3.03c-.608,0-1.18.277-1.56.752l-3.60,4.51,4.55,1.08"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m17,13.99v3.03c0,.608-.277,1.18-.752,1.56l-4.51,3.60-1.08-4.55"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<circle
				cx="15.5"
				cy="8.5"
				r=".5"
				fill="currentColor"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m4.40,16.95c-.31.15-.62.37-.918.67-1.16,1.16-1.48,4.38-1.48,4.38,0,0,3.22-.324,4.38-1.48.297-.297.51-.608.67-.918"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m10.64,17.64c5.76-1.58,10.56-6.50,11.35-15.64-9.14.786-14.06,5.58-15.64,11.35l4.29,4.29Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { RocketIcon }
