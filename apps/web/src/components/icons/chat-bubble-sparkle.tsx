import type { IconProps } from "./icon"

function ChatBubbleSparkleIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="M19.2578 7.25781L22 6.01136V4.98864L19.2578 3.74219L18.0114 1H16.9886L15.7422 3.74219L13 4.98864V6.01136L15.7422 7.25781L16.9886 10H18.0114L19.2578 7.25781Z" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M10 5H3V21H3.41602L5.37891 17.5098L5.66504 17H21V10.2578L21.7734 9.90723L23 9.34863V19H6.83398L4.87109 22.4902L4.58496 23H1V3H10V5Z" fill="currentColor" />
    </svg>
  )
}
export { ChatBubbleSparkleIcon }
