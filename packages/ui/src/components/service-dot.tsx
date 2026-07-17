import { getServiceColor } from "../lib/colors"
import { cn } from "../lib/utils"

/**
 * Small color blob identifying a service. The color is deterministic from the
 * service name (see getServiceColor), so a service is recognizable by the same
 * color everywhere in the product. Decorative only — the adjacent service name
 * remains the accessible label.
 */
export function ServiceDot({ serviceName, className }: { serviceName: string; className?: string }) {
	return (
		<span
			aria-hidden
			className={cn("size-2 shrink-0 rounded-[35%] [corner-shape:squircle]", className)}
			style={{ backgroundColor: getServiceColor(serviceName) }}
		/>
	)
}
