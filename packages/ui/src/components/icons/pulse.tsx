import type { IconProps } from "./icon"

function PulseIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="M2 12H4L5.5 9L9.5 18L14.5 6L18.5 15L20 12H22" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  )
}
export { PulseIcon }
