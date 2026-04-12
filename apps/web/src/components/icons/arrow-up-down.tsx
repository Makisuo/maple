import type { IconProps } from "./icon"

function ArrowUpDownIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" aria-hidden="true" {...props}>
      <path d="M7 4L7 20M7 4L4 7M7 4L10 7M17 20V4M17 20L14 17M17 20L20 17"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

export { ArrowUpDownIcon }
