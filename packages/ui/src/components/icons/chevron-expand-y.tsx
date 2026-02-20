import type { IconProps } from "./icon"

function ChevronExpandYIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <polyline points="7 8 12 3 17 8" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <polyline points="17 16 12 21 7 16" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { ChevronExpandYIcon }
