import type { IconProps } from "./icon"

function KeyIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle
				cx="8"
				cy="16"
				r="1"
				fill="currentColor"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m17,2l-7.144,7.144c-.438-.093-.891-.144-1.356-.144-3.59,0-6.5,2.91-6.5,6.5s2.91,6.5,6.5,6.5,6.5-2.91,6.5-6.5c0-.749-.133-1.465-.366-2.134l2.366-2.366v-3h3l2-2V2h-5Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { KeyIcon }
