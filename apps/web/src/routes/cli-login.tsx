import { useOrganization } from "@clerk/clerk-react"
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { Schema } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { AuthLayout } from "@/components/layout/auth-layout"
import { ClerkOrgSwitcherMenu } from "@/components/dashboard/org-switcher-menu"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const CliLoginSearch = Schema.Struct({
	user_code: Schema.optional(Schema.String),
})

type DeviceInfo = {
	readonly userCode: string
	readonly deviceName: string
	readonly expiresAt: string
	readonly status: "pending" | "approved" | "denied" | "complete"
}

type PageState =
	| { readonly _tag: "entry" }
	| { readonly _tag: "loading" }
	| { readonly _tag: "ready"; readonly info: DeviceInfo }
	| { readonly _tag: "approved" }
	| { readonly _tag: "denied" }
	| { readonly _tag: "error"; readonly message: string }

export const normalizeCliUserCode = (value: string) => {
	const normalized = value
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 8)
	return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized
}

const errorMessage = async (response: Response, fallback: string) => {
	const body = (await response.json().catch(() => null)) as { message?: unknown } | null
	return typeof body?.message === "string" && body.message.length > 0 ? body.message : fallback
}

const authRequest = async (path: string, init?: RequestInit) => {
	const headers = await getMapleAuthHeaders()
	return window.fetch(`${apiBaseUrl}${path}`, {
		...init,
		headers: { ...headers, ...init?.headers },
	})
}

export const inspectCliDevice = async (userCode: string): Promise<DeviceInfo> => {
	const response = await authRequest(`/api/auth/cli/device/${encodeURIComponent(userCode)}`)
	if (!response.ok)
		throw new Error(await errorMessage(response, "This CLI login code is invalid or expired."))
	return (await response.json()) as DeviceInfo
}

const actOnCliDevice = async (userCode: string, action: "approve" | "deny") => {
	const response = await authRequest(`/api/auth/cli/device/${encodeURIComponent(userCode)}/${action}`, {
		method: "POST",
	})
	if (!response.ok) throw new Error(await errorMessage(response, `Unable to ${action} CLI access.`))
}

export const Route = createFileRoute("/cli-login")({
	component: CliLoginPage,
	validateSearch: Schema.toStandardSchemaV1(CliLoginSearch),
})

function WorkspaceChoice() {
	const auth = Route.useRouteContext({ select: (context) => context.auth })
	return (
		<div className="flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2">
			<div className="min-w-0">
				<p className="text-xs text-muted-foreground">Workspace</p>
				<p className="truncate text-sm font-medium">{auth.orgId}</p>
			</div>
		</div>
	)
}

function ClerkWorkspaceChoice() {
	const { organization } = useOrganization()
	return (
		<div className="flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2">
			<div className="min-w-0">
				<p className="text-xs text-muted-foreground">Workspace</p>
				<p className="truncate text-sm font-medium">{organization?.name ?? "Current workspace"}</p>
			</div>
			<ClerkOrgSwitcherMenu
				trigger={
					<Button type="button" variant="outline" size="sm">
						Switch
					</Button>
				}
				contentAlign="end"
			/>
		</div>
	)
}

const ActiveWorkspaceChoice = isClerkAuthEnabled ? ClerkWorkspaceChoice : WorkspaceChoice

function CliLoginPage() {
	const { user_code: initialCode } = Route.useSearch()
	const [userCode, setUserCode] = useState(() => normalizeCliUserCode(initialCode ?? ""))
	const [state, setState] = useState<PageState>(() =>
		initialCode ? { _tag: "loading" } : { _tag: "entry" },
	)

	const inspect = async (code: string) => {
		const normalized = normalizeCliUserCode(code)
		if (normalized.replace("-", "").length !== 8) {
			setState({ _tag: "error", message: "Enter the eight-character code shown in your terminal." })
			return
		}
		setState({ _tag: "loading" })
		try {
			const info = await inspectCliDevice(normalized)
			if (info.status === "denied") setState({ _tag: "denied" })
			else if (info.status === "approved" || info.status === "complete") setState({ _tag: "approved" })
			else setState({ _tag: "ready", info })
		} catch (error) {
			setState({
				_tag: "error",
				message: error instanceof Error ? error.message : "Unable to inspect this CLI login code.",
			})
		}
	}

	useMountEffect(() => {
		if (initialCode) void inspect(initialCode)
	})

	const submitCode = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		void inspect(userCode)
	}

	const decide = async (action: "approve" | "deny") => {
		if (state._tag !== "ready") return
		setState({ _tag: "loading" })
		try {
			await actOnCliDevice(state.info.userCode, action)
			setState({ _tag: action === "approve" ? "approved" : "denied" })
		} catch (error) {
			setState({
				_tag: "error",
				message: error instanceof Error ? error.message : `Unable to ${action} CLI access.`,
			})
		}
	}

	return (
		<AuthLayout maxWidth="max-w-md">
			<div className="space-y-5">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold">Authorize Maple CLI</h1>
					<p className="text-sm text-muted-foreground">
						Approve a terminal session without copying an API key.
					</p>
				</div>

				{state._tag === "entry" || state._tag === "error" ? (
					<form className="space-y-3" onSubmit={submitCode}>
						<label className="block space-y-1.5">
							<span className="text-sm font-medium">One-time code</span>
							<Input
								type="text"
								value={userCode}
								onChange={(event) => setUserCode(normalizeCliUserCode(event.target.value))}
								placeholder="ABCD-EFGH"
								autoComplete="one-time-code"
								className="font-mono uppercase tracking-widest"
								aria-invalid={state._tag === "error"}
							/>
						</label>
						{state._tag === "error" ? (
							<p role="alert" className="text-sm text-destructive">
								{state.message}
							</p>
						) : null}
						<Button type="submit" className="w-full">
							Continue
						</Button>
					</form>
				) : null}

				{state._tag === "loading" ? (
					<p role="status" className="py-8 text-center text-sm text-muted-foreground">
						Checking authorization…
					</p>
				) : null}

				{state._tag === "ready" ? (
					<div className="space-y-4">
						<div className="space-y-1 border border-border bg-muted/30 p-3">
							<p className="text-xs text-muted-foreground">Requesting device</p>
							<p className="font-medium">{state.info.deviceName}</p>
							<p className="font-mono text-sm text-muted-foreground">{state.info.userCode}</p>
							<p className="text-xs text-muted-foreground">
								Expires at {new Date(state.info.expiresAt).toLocaleTimeString()}
							</p>
						</div>
						<ActiveWorkspaceChoice />
						<p className="text-sm text-muted-foreground">
							The CLI will receive a revocable credential with your current workspace role.
						</p>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={() => void decide("deny")}
							>
								Deny
							</Button>
							<Button type="button" className="flex-1" onClick={() => void decide("approve")}>
								Approve
							</Button>
						</div>
					</div>
				) : null}

				{state._tag === "approved" ? (
					<div className="py-6 text-center" role="status">
						<p className="font-medium">CLI access approved</p>
						<p className="mt-1 text-sm text-muted-foreground">
							You can close this tab and return to your terminal.
						</p>
					</div>
				) : null}

				{state._tag === "denied" ? (
					<div className="py-6 text-center" role="status">
						<p className="font-medium">CLI access denied</p>
						<p className="mt-1 text-sm text-muted-foreground">No credential was created.</p>
					</div>
				) : null}
			</div>
		</AuthLayout>
	)
}
