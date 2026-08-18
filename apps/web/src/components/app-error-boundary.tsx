/**
 * Last-resort boundary for errors outside router boundaries. It has no router
 * context; crash artwork geometry is coupled to `.boot-*`/`.crash-*` in styles.css.
 */
import { Component, type ReactNode } from "react"

import { buttonVariants } from "@maple/ui/components/ui/button"
import { isChunkLoadError, shouldAttemptChunkReload } from "@/lib/chunk-reload"
import { displayError } from "@/lib/error-messages"

interface AppErrorBoundaryProps {
	children: ReactNode
}

interface AppErrorBoundaryState {
	error: unknown
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: undefined }

	static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
		return { error }
	}

	componentDidCatch(error: unknown) {
		if (isChunkLoadError(error) && shouldAttemptChunkReload()) {
			window.location.reload()
		}
	}

	render() {
		if (this.state.error !== undefined) {
			return <CrashScreen error={this.state.error} />
		}
		// Append ?__crash in development to preview the crash screen.
		if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("__crash")) {
			return (
				<CrashScreen error={new TypeError("Cannot read properties of undefined (reading 'spans')")} />
			)
		}
		return this.props.children
	}
}

function CrashScreen({ error }: { error: unknown }) {
	const name = error instanceof Error ? error.name : "Error"
	const presentation = displayError(error)
	const stack = error instanceof Error ? error.stack : undefined

	return (
		<main
			role="alert"
			aria-live="assertive"
			aria-label="Maple crashed"
			className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-background px-6"
		>
			<div className="crash-trace" aria-hidden="true">
				<span className="boot-track boot-track--1" />
				<span className="boot-track boot-track--2" />
				<span className="boot-track boot-track--3" />
				<span className="boot-track boot-track--4" />
				<span className="boot-track boot-track--5" />
				<span className="crash-span boot-span--1" />
				<span className="crash-span boot-span--2" />
				<span className="crash-span boot-span--3" />
				<span className="crash-span crash-span--error boot-span--4" />
				<span className="crash-scan" />
			</div>

			<div className="flex max-w-md flex-col items-center gap-1.5 text-center">
				<h1 className="font-display text-base font-semibold text-foreground">
					The dashboard crashed
				</h1>
				<p className="text-sm text-balance text-muted-foreground">
					{presentation.message} Your telemetry is safe — reloading usually recovers it.
				</p>
			</div>

			<div className="flex items-center gap-2">
				<button
					type="button"
					className={buttonVariants({ size: "sm", variant: "default" })}
					onClick={() => window.location.reload()}
				>
					Reload dashboard
				</button>
				<a href="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
					Go to home
				</a>
			</div>

			{import.meta.env.DEV && (
				<details className="w-full max-w-2xl text-left">
					<summary className="cursor-pointer text-xs text-muted-foreground select-none">
						{name} details
					</summary>
					<pre className="mt-2 overflow-auto bg-muted p-3 font-mono text-[11px] leading-relaxed">
						{stack ?? presentation.title}
					</pre>
				</details>
			)}
		</main>
	)
}
