import { useOrganization } from "@clerk/clerk-react"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { AuthLayout } from "@/components/layout/auth-layout"
import { ClerkOrgSwitcherMenu } from "@/components/dashboard/org-switcher-menu"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const McpAuthorizeSearch = Schema.Struct({
	request_id: Schema.optional(Schema.String),
})

type AuthorizationInfo = {
	readonly clientName: string
	readonly redirectUri: string
	readonly resource: string
	readonly scopes: ReadonlyArray<string>
	readonly expiresAt: string
	readonly status: "pending" | "approved" | "denied" | "used"
}

type AuthorizationAction = {
	readonly status: "approved" | "denied"
	readonly redirectUri: string
}

type PageState =
	| { readonly _tag: "loading" }
	| { readonly _tag: "ready"; readonly info: AuthorizationInfo }
	| { readonly _tag: "redirecting" }
	| { readonly _tag: "error"; readonly message: string }

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

export const inspectMcpAuthorization = async (requestId: string): Promise<AuthorizationInfo> => {
	const response = await authRequest(`/api/auth/mcp/oauth/authorization/${encodeURIComponent(requestId)}`)
	if (!response.ok) {
		throw new Error(await errorMessage(response, "This MCP authorization request is invalid or expired."))
	}
	return (await response.json()) as AuthorizationInfo
}

export const decideMcpAuthorization = async (
	requestId: string,
	action: "approve" | "deny",
): Promise<AuthorizationAction> => {
	const response = await authRequest(
		`/api/auth/mcp/oauth/authorization/${encodeURIComponent(requestId)}/${action}`,
		{ method: "POST" },
	)
	if (!response.ok) {
		throw new Error(await errorMessage(response, `Unable to ${action} MCP access.`))
	}
	return (await response.json()) as AuthorizationAction
}

export const Route = createFileRoute("/mcp-authorize")({
	component: McpAuthorizePage,
	validateSearch: Schema.toStandardSchemaV1(McpAuthorizeSearch),
})

function SelfHostedWorkspaceChoice() {
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

const ActiveWorkspaceChoice = isClerkAuthEnabled ? ClerkWorkspaceChoice : SelfHostedWorkspaceChoice

function McpAuthorizePage() {
	const { request_id: requestId } = Route.useSearch()
	const [state, setState] = useState<PageState>({ _tag: "loading" })

	useMountEffect(() => {
		if (!requestId) {
			setState({ _tag: "error", message: "This authorization link is incomplete." })
			return
		}
		void inspectMcpAuthorization(requestId)
			.then((info) => {
				if (info.status !== "pending") {
					setState({ _tag: "error", message: "This authorization request has already been used." })
					return
				}
				setState({ _tag: "ready", info })
			})
			.catch((error: unknown) => {
				setState({
					_tag: "error",
					message:
						error instanceof Error ? error.message : "Unable to load this authorization request.",
				})
			})
	})

	const decide = async (action: "approve" | "deny") => {
		if (!requestId || state._tag !== "ready") return
		setState({ _tag: "redirecting" })
		try {
			const result = await decideMcpAuthorization(requestId, action)
			window.location.assign(result.redirectUri)
		} catch (error) {
			setState({
				_tag: "error",
				message: error instanceof Error ? error.message : `Unable to ${action} MCP access.`,
			})
		}
	}

	return (
		<AuthLayout maxWidth="max-w-md">
			<div className="space-y-5">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold">Authorize Maple MCP</h1>
					<p className="text-sm text-muted-foreground">
						Connect an AI client to your Maple observability workspace.
					</p>
				</div>

				{state._tag === "loading" || state._tag === "redirecting" ? (
					<p role="status" className="py-8 text-center text-sm text-muted-foreground">
						{state._tag === "loading"
							? "Checking authorization…"
							: "Returning to your MCP client…"}
					</p>
				) : null}

				{state._tag === "error" ? (
					<div className="space-y-3">
						<p
							role="alert"
							className="border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
						>
							{state.message}
						</p>
						<p className="text-sm text-muted-foreground">
							Return to your MCP client and start the connection again.
						</p>
					</div>
				) : null}

				{state._tag === "ready" ? (
					<div className="space-y-4">
						<div className="space-y-1 border border-border bg-muted/30 p-3">
							<p className="text-xs text-muted-foreground">Requesting client</p>
							<p className="font-medium">{state.info.clientName}</p>
							<p className="truncate text-xs text-muted-foreground">
								Returns to {new URL(state.info.redirectUri).host}
							</p>
							<p className="text-xs text-muted-foreground">
								Expires at {new Date(state.info.expiresAt).toLocaleTimeString()}
							</p>
						</div>
						<ActiveWorkspaceChoice />
						<div className="space-y-1 text-sm text-muted-foreground">
							<p>This grants the client permission to:</p>
							<ul className="list-disc space-y-1 pl-5">
								<li>Search and inspect telemetry through Maple MCP tools</li>
								<li>Act with your current role in this workspace</li>
							</ul>
						</div>
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
			</div>
		</AuthLayout>
	)
}
