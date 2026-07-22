// Shared loading / empty / error placeholders so every view reads the same way.
// Built on the @maple/ui `Empty` compound + `Skeleton` so local mode matches the
// main web app's states exactly.

import type { ReactNode } from "react"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { CircleWarningIcon, ConnectionIcon } from "@maple/ui/components/icons"
import { LOCAL_OTLP_ENDPOINT, localApiBase } from "../lib/constants"
import { DOCS_CLI_REFERENCE, DOCS_LOCAL_MODE_INSTALL, INSTALL_METHODS } from "../lib/links"
import { CopyableField } from "./copyable-field"

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
	return (
		<Empty className="h-full">
			{icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				{hint ? <EmptyDescription>{hint}</EmptyDescription> : null}
			</EmptyHeader>
		</Empty>
	)
}

export function ErrorState({
	label,
	error,
	onRetry,
}: {
	label: string
	error: unknown
	onRetry?: () => void
}) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<CircleWarningIcon className="text-destructive" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Couldn’t load {label}</EmptyTitle>
				<EmptyDescription className="font-mono text-xs break-all">{message}</EmptyDescription>
			</EmptyHeader>
			{onRetry ? (
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	)
}

/**
 * Shown in place of the views when the local `maple` binary is unreachable —
 * the connection gate in `App` swaps to this instead of leaving an infinite
 * skeleton. Tells the user how to start the backend; the gate keeps polling, so
 * it auto-recovers (and "Try again" forces an immediate probe).
 */
export function DisconnectedState({ onRetry }: { onRetry: () => void }) {
	// `?port=` only matters in remote mode (the UI on local.maple.dev reaching
	// loopback); on same-origin/dev `localApiBase()` is "" and the port is fixed.
	const isRemote = localApiBase() !== ""
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<ConnectionIcon className="text-muted-foreground" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Can’t reach Maple Local</EmptyTitle>
				<EmptyDescription>
					Start your local Maple backend and this view connects automatically.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-md items-stretch gap-3 text-left">
				<InstallCommands />

				<Separator />

				<span className="text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Already installed?
				</span>
				<CopyableField label="Start Maple" value="maple start" />
				<CopyableField label="Expecting" value={LOCAL_OTLP_ENDPOINT} />
				<p className="text-left text-xs text-muted-foreground">
					Make sure <code className="rounded bg-muted px-1">maple start</code> is running.
					{isRemote ? (
						<>
							{" "}
							On a different port? Append{" "}
							<code className="rounded bg-muted px-1">?port=&lt;n&gt;</code> to the URL.
						</>
					) : null}
				</p>
				<div className="flex items-center justify-between gap-2">
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<DocsLink href={DOCS_LOCAL_MODE_INSTALL}>Local mode</DocsLink>
						<span aria-hidden="true">·</span>
						<DocsLink href={DOCS_CLI_REFERENCE}>CLI reference</DocsLink>
					</span>
				</div>
			</EmptyContent>
		</Empty>
	)
}

/**
 * Homebrew / install-script commands for the `maple` binary — the disconnected
 * screen is the one place where the user may not have the CLI at all, so the
 * install path lives right next to "start it". Commands mirror the landing
 * page's install tabs (see `lib/links.ts`).
 */
function InstallCommands() {
	return (
		<Tabs defaultValue={INSTALL_METHODS[0].id} className="gap-2">
			<TabsList variant="underline" className="justify-start">
				{INSTALL_METHODS.map((method) => (
					<TabsTrigger key={method.id} value={method.id}>
						{method.label}
					</TabsTrigger>
				))}
			</TabsList>
			{INSTALL_METHODS.map((method) => (
				<TabsContent key={method.id} value={method.id} className="mt-0">
					<CopyableField label="" value={method.command} />
				</TabsContent>
			))}
		</Tabs>
	)
}

function DocsLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="underline underline-offset-2 hover:no-underline"
		>
			{children}
		</a>
	)
}

/**
 * Content-shaped loading placeholder. `table` for the trace/log row lists,
 * `card` for the session card stack — keeps every loading state on the same
 * skeleton vocabulary instead of a bare spinner.
 */
export function ListSkeleton({ rows = 8, variant = "table" }: { rows?: number; variant?: "table" | "card" }) {
	return (
		<div className="space-y-2 p-4">
			{Array.from({ length: rows }).map((_, i) => (
				<Skeleton
					key={i}
					className={variant === "card" ? "h-[68px] w-full rounded-xl" : "h-10 w-full rounded-md"}
				/>
			))}
		</div>
	)
}
