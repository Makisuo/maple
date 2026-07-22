// Outbound links + install commands surfaced by the local UI.
//
// The install commands mirror the landing page's `InstallTabs.astro` — keep both
// in sync (the script itself is served from `apps/landing/public/cli/install`).
// Doc URLs point at the specific local-mode page that answers the question in
// front of the user, never the docs root.

const DOCS_ROOT = "https://maple.dev/docs"

/** Guided local-mode walkthrough: install → start → send telemetry. */
export const DOCS_LOCAL_MODE = `${DOCS_ROOT}/local-mode`

/** Install section of the local-mode guide (Homebrew + script, upgrade/uninstall). */
export const DOCS_LOCAL_MODE_INSTALL = `${DOCS_LOCAL_MODE}#install`

/** OTLP exporter setup — matches the Connect popover's contents. */
export const DOCS_LOCAL_MODE_SEND_TELEMETRY = `${DOCS_LOCAL_MODE}#send-telemetry`

/** Every command, argument, and flag of the `maple` CLI. */
export const DOCS_CLI_REFERENCE = `${DOCS_LOCAL_MODE}/cli-reference`

export interface InstallMethod {
	readonly id: string
	readonly label: string
	readonly command: string
}

/** Homebrew first — it's the recommended path on macOS and Linux. */
export const INSTALL_METHODS: readonly InstallMethod[] = [
	{ id: "homebrew", label: "Homebrew", command: "brew install Makisuo/tap/maple" },
	{ id: "script", label: "Install script", command: "curl -fsSL https://maple.dev/cli/install | sh" },
]
