import { cn } from "../../lib/utils"
import { LoaderIcon } from "../icons"

function Spinner({
  className,
  strokeWidth,
  ...props
}: React.ComponentProps<"svg"> & { strokeWidth?: number }) {
  return (
    <LoaderIcon
      strokeWidth={strokeWidth ?? 2}
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
