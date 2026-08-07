import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M22.1124 12.6445C22.1726 13.7505 22.171 15.0645 22.0489 16.5",
	"M5.25996 4.61032C6.53486 3.44537 8.12846 2.59561 9.94078 2.21431C14.6657 1.2202 19.3131 3.73934 21.1669 7.99999",
	"M17.3609 13.2941C17.2305 12.2995 17.0383 11.4201 16.8296 10.7059C16.1149 8.03859 13.3733 6.45568 10.7059 7.17039C8.03859 7.8851 6.45568 10.6268 7.17039 13.2941C7.91881 15.7352 8.39898 18.0087 7.7516 21",
	"M12 12C12.8527 14.8425 13.4109 17.9853 12.5514 22",
	"M17.754 17.3285C17.7722 18.2469 17.754 19.5447 17.3469 21.0039",
	"M2.83362 8C2.0282 9.84132 1.76851 11.9423 2.21384 14.0589C2.51549 15.4927 2.79591 16.7127 2.8852 18",
]

function FingerprintIcon({ size = 24, className, ...props }: IconProps) {
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
			{paths.map((d, i) => (
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { FingerprintIcon }
