import type { IconProps } from "./icon"

function UploadIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" aria-hidden="true" {...props}>
      <path d="M12 16V3V3.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M8.5 6.5L12 3L15.5 6.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M7 10H4L2 20H22L20 10H17" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
    </svg>
  )
}
export { UploadIcon }
