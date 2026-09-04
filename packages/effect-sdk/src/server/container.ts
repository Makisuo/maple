// Best-effort Docker container identity detection
//
// Emits `container.runtime` / `container.id` resource attributes so spans and
// logs from an app running inside a plain Docker container correlate with the
// docker_stats metrics the Maple Docker agent collects.
//
// Detection is inherently best-effort on modern Docker:
// - cgroup v2 with a private cgroup namespace (the default) renders
//   `/proc/self/cgroup` as `0::/`, hiding the container id — but
//   `/proc/self/mountinfo` usually still carries the id in the overlay paths.
// - The hostname fallback only fires when `/.dockerenv` exists AND the hostname
//   is 12 hex chars (Docker's default); a user-set `hostname:` defeats it.
// The reliable path is documented instead: set
// `OTEL_RESOURCE_ATTRIBUTES=container.id=…,container.name=…`, which takes
// precedence over these values (later writers win in `resolveResource`).
//
// No static `node:fs`/`node:os` imports: this module is bundled into the
// Cloudflare preset's dependency graph, where those specifiers break the
// build. `process.getBuiltinModule` (Node ≥ 20.16, Bun) loads them lazily and
// synchronously; when it's absent, detection just reports nothing.

import { trySyncOrUndefined } from "../shared/try-sync.js"

const CONTAINER_ID_RE = /\/docker\/containers\/([0-9a-f]{64})\//
const CGROUP_ID_RE = /([0-9a-f]{64})/
const SHORT_ID_HOSTNAME_RE = /^[0-9a-f]{12}$/

export interface ContainerProbe {
	/** True when the path exists — `/.dockerenv` is the Docker marker file. */
	readonly exists: (path: string) => boolean
	readonly readFile: (path: string) => string
	readonly hostname: () => string
}

/**
 * Pure derivation from probed inputs — the testable core. Every probe call is
 * guarded by the caller (`getContainerAttributes` wraps the whole thing).
 */
export const deriveContainerAttributes = (probe: ContainerProbe): Record<string, string> => {
	const inDocker = trySyncOrUndefined(() => probe.exists("/.dockerenv")) ?? false

	const attrs: Record<string, string> = {}
	// `container.runtime.name` since semconv v1.37.0; the bare `container.runtime`
	// it replaced is not emitted, because every read path coalesces both
	// spellings anyway (`containerRuntimeExpr`) for the sake of third-party
	// collectors that still send the old one.
	if (inDocker) attrs["container.runtime.name"] = "docker"

	// Lazy fallback chain — this runs at every SDK boot (customer processes),
	// and mountinfo can run to hundreds of KB, so later probes only fire when
	// the earlier ones miss.
	const containerId =
		trySyncOrUndefined(() => probe.readFile("/proc/self/mountinfo").match(CONTAINER_ID_RE)?.[1]) ??
		trySyncOrUndefined(() => probe.readFile("/proc/self/cgroup").match(CGROUP_ID_RE)?.[1]) ??
		(inDocker
			? trySyncOrUndefined(() => {
					const name = probe.hostname()
					return SHORT_ID_HOSTNAME_RE.test(name) ? name : undefined
				})
			: undefined)
	if (containerId) attrs["container.id"] = containerId
	return attrs
}

type FsModule = { existsSync: (path: string) => boolean; readFileSync: (path: string, enc: string) => string }
type OsModule = { hostname: () => string }

/**
 * The two builtin loads this module performs, declared as an overload pair so
 * `getBuiltinModule` never surfaces an untyped value to callers.
 */
type LoadBuiltin = ((id: "node:fs") => FsModule | undefined) & ((id: "node:os") => OsModule | undefined)

let cached: Record<string, string> | undefined

/**
 * Read live container identity from the filesystem, memoized for the process
 * lifetime (container identity cannot change under a running process). Returns
 * `{}` anywhere the probes aren't available — non-Linux, workerd, browsers.
 */
export const getContainerAttributes = (): Record<string, string> => {
	if (cached) return cached
	const proc = (
		globalThis as {
			process?: { platform?: string; getBuiltinModule?: LoadBuiltin }
		}
	).process
	const loadBuiltin = proc?.getBuiltinModule
	if (proc?.platform !== "linux" || typeof loadBuiltin !== "function") {
		return (cached = {})
	}
	const fs = trySyncOrUndefined(() => loadBuiltin("node:fs"))
	const os = trySyncOrUndefined(() => loadBuiltin("node:os"))
	if (!fs || !os) return (cached = {})

	return (cached = deriveContainerAttributes({
		exists: (path) => fs.existsSync(path),
		readFile: (path) => fs.readFileSync(path, "utf8"),
		hostname: () => os.hostname(),
	}))
}
