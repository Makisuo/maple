import type { ErrorComponentProps } from "@tanstack/react-router"
import { Link, useRouter } from "@tanstack/react-router"
import { AlertWarningIcon, CircleQuestionIcon, HouseIcon } from "@/components/icons"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { useNetworkAutoRetry } from "@/hooks/use-network-auto-retry"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { formatBackendError } from "@/lib/error-messages"
import { isChunkLoadError, shouldAttemptChunkReload } from "@/lib/chunk-reload"

function RouteError({ error, reset }: ErrorComponentProps) {
	const router = useRouter()
	const isStaleChunk = isChunkLoadError(error)

	const formatted = formatBackendError(error)
	const { title } = formatted
	const stack = error instanceof Error ? error.stack : undefined

	const retry = () => {
		reset()
		router.invalidate()
	}
	// Route-loader transport failures self-heal without a manual reload.
	const autoRetrying = useNetworkAutoRetry(
		formatted.recovery.kind === "retry" && formatted.recovery.automatic && !isStaleChunk,
		retry,
	)
	const description = autoRetrying
		? `${formatted.description} Retrying automatically…`
		: formatted.description
	const canRetry = formatted.recovery.kind === "retry" || formatted.recovery.kind === "reload"
	const shouldReload = isStaleChunk || formatted.recovery.kind === "reload"

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

export { RouteError, NotFoundError }
