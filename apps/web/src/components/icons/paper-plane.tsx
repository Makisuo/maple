import type { IconProps } from "./icon"

function PaperPlaneIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" aria-hidden="true" {...props}>
      <polyline points="21.5 2.5 7 12.875 7 21 12 16.625" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" />
      <polygon points="2.5 9.5 21.5 2.5 18.5 21.5 2.5 9.5" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { PaperPlaneIcon }
