import type { IconProps } from "./icon"

function CircleInfoIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <path d="m12,17v-5.5c0-.276-.224-.5-.5-.5h-1.5" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <circle cx="12" cy="7.25" r="1.25" fill="currentColor" strokeWidth="0" />
    </svg>
  )
}
export { CircleInfoIcon }
