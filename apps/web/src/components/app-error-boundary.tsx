/**
 * Last-resort crash screen for errors that escape the router.
 *
 * The router's `RouteError` catches errors inside route boundaries; anything
 * thrown outside them (Clerk bridge, auth settling, providers) used to unmount
 * the whole tree and leave a blank white page. This boundary wraps the entire
 * app in `main.tsx` and renders a branded crash state instead.
 *
 * Visually it is the BootSplash's trace waterfall frozen at the moment of
 * failure: the first spans landed, the fourth errored (red, where the playhead
 * stopped), and the fifth never arrived — Maple's own material standing in for
 * a generic error illustration. Keep the row geometry in sync with the
 * `.boot-*` / `.crash-*` rules in `styles.css`.
 *
 * No router context exists here, so navigation uses plain anchors and
 * `window.location`. Stale-chunk errors auto-reload, same as `RouteError`.
 */
import { Component, type ReactNode } from "react"

import { buttonVariants } from "@maple/ui/components/ui/button"
import { isChunkLoadError, shouldAttemptChunkReload } from "@/lib/chunk-reload"

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
		// Dev-only preview: append ?__crash to any URL to render the crash screen
		// without breaking the app (the boundary only fires on real render errors).
		if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("__crash")) {
			return (
				<CrashScreen
					error={new TypeError("Cannot read properties of undefined (reading 'spans')")}
				/>
			)
		}
		return this.props.children
	}
}

function CrashScreen({ error }: { error: unknown }) {
	const name = error instanceof Error ? error.name : "Error"
	const message =
		error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error"
	const stack = error instanceof Error ? error.stack : undefined

	return (
		<main
			role="alert"
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
					An unexpected error stopped this session. Your telemetry is safe — reloading usually
					recovers it.
				</p>
			</div>

			<div className="w-full max-w-md overflow-hidden rounded-lg border bg-muted/30">
				<div className="flex items-center gap-2 border-b bg-background/60 px-3 py-1.5">
					<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
					<span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
						{name}
					</span>
				</div>
				<p className="max-h-24 overflow-y-auto px-3 py-2 font-mono text-xs break-words text-muted-foreground">
					{message}
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

			{import.meta.env.DEV && stack && (
				<details className="w-full max-w-2xl text-left">
					<summary className="cursor-pointer text-xs text-muted-foreground select-none">
						Stack trace
					</summary>
					<pre className="mt-2 overflow-auto bg-muted p-3 font-mono text-[11px] leading-relaxed">
						{stack}
					</pre>
				</details>
			)}
		</main>
	)
}
