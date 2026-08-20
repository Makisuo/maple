import type { IconProps } from "./icon"

function TelegramIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M21.73 3.16a1.2 1.2 0 0 0-1.22-.2L2.9 9.9c-.55.22-.9.74-.89 1.33s.38 1.09.94 1.28l3.92 1.35l1.5 4.77c.02.06.05.11.08.16c0 .01.01.02.02.03a.9.9 0 0 0 .2.19l.03.02c.07.05.14.08.22.1h.02c.08.03.15.04.23.04h.01c.11 0 .21-.02.31-.06h.02c.05-.02.1-.05.15-.09l2.6-1.94l3.9 3.02c.22.17.48.26.75.26c.13 0 .27-.02.4-.07c.4-.14.69-.47.78-.88l3.13-14.9c.09-.42-.06-.86-.39-1.13ZM9.6 13.44l-.55 2.24l-.75-2.4l6.35-3.86l-4.9 3.66c-.08.09-.13.2-.15.32Z" />
		</svg>
	)
}
export { TelegramIcon }
