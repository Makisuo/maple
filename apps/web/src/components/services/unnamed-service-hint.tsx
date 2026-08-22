import { Badge } from "@maple/ui/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

/**
 * The SDK's synthetic `unknown_service[:runtime]` default, or an empty name —
 * the same predicate the setup audit uses. Either means the instrumentation
 * never set `service.name`, and the first thing a new user sees is a service
 * they didn't name.
 */
export function isUnnamedService(serviceName: string): boolean {
	return serviceName === "" || serviceName.startsWith("unknown_service")
}

/** An inline "you forgot service.name" tag, for anywhere a service name is a headline. */
export function UnnamedServiceHint() {
	return (
		<Tooltip>
			<TooltipTrigger
				render={<Badge variant="warning" size="sm" className="shrink-0 font-normal" />}
				onClick={(event) => event.stopPropagation()}
			>
				no service.name
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs">
				This SDK never set <code className="font-mono">service.name</code>, so OpenTelemetry fell back
				to its default. Set <code className="font-mono">OTEL_SERVICE_NAME</code> (or{" "}
				<code className="font-mono">serviceName</code> in your SDK config) and the service will appear
				under its real name.
			</TooltipContent>
		</Tooltip>
	)
}
