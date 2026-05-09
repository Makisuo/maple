import type { IconProps } from "./icon"

// Source: simple-icons (MIT) — https://simpleicons.org/icons/clickhouse
function ClickhouseIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="#FFCC00"
			aria-hidden="true"
			{...props}
		>
			<path d="M21.33 10H24v4h-2.66ZM16 1.33h2.66v21.33H16Zm-5.33 0h2.66v21.33h-2.66ZM0 22.66V1.33h2.66v21.33zm5.33-21.33H8v21.33H5.33Z" />
		</svg>
	)
}

export { ClickhouseIcon }
