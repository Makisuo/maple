import type { IconProps } from "./icon"

function AlertWarningIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <circle cx="12" cy="20.5" r=".5" fill="currentColor" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { AlertWarningIcon }
