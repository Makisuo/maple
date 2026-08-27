import type { ErrorComponentProps } from "@tanstack/react-router"
import { Link, useRouter } from "@tanstack/react-router"
import { AlertWarningIcon, CircleQuestionIcon, HouseIcon } from "@/components/icons"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { useNetworkAutoRetry } from "@/hooks/use-network-auto-retry"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { displayError, isAutomaticRetryError, isUnexpectedError } from "@/lib/error-messages"
import { isChunkLoadError, shouldAttemptChunkReload } from "@/lib/chunk-reload"
import { captureException } from "@/lib/services/common/otel-layer"

/**
 * Component stacks per caught error, recorded from the router's
 * `defaultOnCatch`. The router's error boundary receives React's `errorInfo`
 * but never forwards it to the error component (`ErrorComponentProps.info` is
 * typed yet unwired), and the component stack is the only thing that locates a
 * minified production render crash — the JS stack is mangled to one frame.
 */
const componentStacks = new WeakMap<object, string>()

function recordRouteErrorInfo(error: unknown, errorInfo: { componentStack?: string | null }): void {
	if (typeof error === "object" && error !== null && errorInfo.componentStack) {
		componentStacks.set(error, errorInfo.componentStack)
	}
}

function RouteError({ error, info, reset }: ErrorComponentProps) {
	const router = useRouter()
	const isStaleChunk = isChunkLoadError(error)

	const formatted = displayError(error)
	const { title } = formatted
	const stack = error instanceof Error ? error.stack : undefined

	const retry = () => {
		reset()
		router.invalidate()
	}
	// Only the ones nothing could classify. A recognized API or network failure
	// already has a failed client span from the Effect layer, so reporting it
	// here would fingerprint the same outage twice — and a stale chunk is a
	// deploy artifact, not a bug.
	const shouldReport = isUnexpectedError(formatted) && !isStaleChunk
	useMountEffect(() => {
		if (!shouldReport) return
		// The stack of a production render crash is minified to uselessness; the
		// component stack and route id are what actually locate the crash.
		const routeId = router.state.matches.at(-1)?.routeId
		const componentStack =
			info?.componentStack ??
			(typeof error === "object" && error !== null ? componentStacks.get(error) : undefined)
		captureException(error, {
			name: "browser.route_error",
			attributes: {
				"maple.exception.source": "route_error_boundary",
				...(routeId !== undefined ? { "maple.route.id": routeId } : undefined),
				...(componentStack
					? { "maple.exception.component_stack": componentStack.slice(0, 4000) }
					: undefined),
			},
		})
	})

	const autoRetrying = useNetworkAutoRetry(isAutomaticRetryError(formatted) && !isStaleChunk, retry)
	const description = autoRetrying ? `${formatted.message} Retrying automatically…` : formatted.message
	const canRetry = formatted.recovery === "retry" || formatted.recovery === "refresh"
	const shouldReload = isStaleChunk || formatted.recovery === "refresh"

	return (
		<Empty className="min-h-[60vh]" role="alert" aria-live="assertive" aria-atomic="true">
			{isStaleChunk ? <StaleChunkReload /> : null}
			<EmptyHeader>
				<EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
					<AlertWarningIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<div className="mt-2 flex items-center gap-2">
				{canRetry ? (
					<Button
						size="sm"
						variant="default"
						onClick={() => {
							if (shouldReload) {
								window.location.reload()
								return
							}
							retry()
						}}
					>
						{shouldReload ? "Reload" : "Try again"}
					</Button>
				) : null}
				<Link to="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
					<HouseIcon size={14} />
					Go home
				</Link>
			</div>
			{import.meta.env.DEV && stack && (
				<details className="mt-4 w-full max-w-2xl text-left">
					<summary className="text-muted-foreground cursor-pointer text-xs select-none">
						Stack trace
					</summary>
					<pre className="bg-muted mt-2 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
						{stack}
					</pre>
				</details>
			)}
		</Empty>
	)
}

function StaleChunkReload() {
	useMountEffect(() => {
		if (shouldAttemptChunkReload()) window.location.reload()
	})
	return null
}

function NotFoundError() {
	return (
		<Empty className="min-h-[60vh]">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CircleQuestionIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>Page not found</EmptyTitle>
				<EmptyDescription>
					The page you're looking for doesn't exist or has been moved.
				</EmptyDescription>
			</EmptyHeader>
			<div className="mt-2">
				<Link to="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
					<HouseIcon size={14} />
					Go home
				</Link>
			</div>
		</Empty>
	)
}

export { RouteError, NotFoundError, recordRouteErrorInfo }
