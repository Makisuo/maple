import type { IconProps } from "./icon"

function LoaderIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path opacity="0.5" d="M12 19V22" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path d="M12 2V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.25" d="M5.005 11.995L2.005 11.995" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.75" d="M22.005 11.995L19.005 11.995" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.38" d="M7.05171 16.9462L4.93039 19.0675" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.88" d="M19.0725 4.92542L16.9512 7.04674" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.13" d="M7.05879 7.04669L4.93747 4.92537" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path opacity="0.63" d="M19.0796 19.0675L16.9583 16.9462" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  )
}
export { LoaderIcon }
