import type { Plugin } from "vite"

/**
 * Emits `/version.json` carrying the commit this bundle was built from.
 *
 * The bundle already knows its own commit — `import.meta.env.VITE_COMMIT_SHA` is
 * baked in at build time for telemetry. What it has no way to know is what the
 * *server* is currently serving, and that gap is why a tab left open across a
 * deploy keeps running old JS indefinitely: nothing tells it otherwise until it
 * happens to request a hashed chunk that no longer exists.
 *
 * A one-line static asset closes it. The client polls this file and compares it
 * against its own baked-in value; a mismatch means a newer bundle is deployed.
 *
 * Deliberately a build artifact rather than a runtime endpoint: it is served by
 * the same assets layer as the bundle it describes, so the two can never
 * disagree about which deploy is live — which a separately-deployed `/version`
 * route absolutely could, mid-rollout.
 */
export function versionManifest(commitSha: string): Plugin {
	return {
		name: "maple:version-manifest",
		apply: "build",
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: "version.json",
				source: JSON.stringify({ commit: commitSha }),
			})
		},
	}
}
