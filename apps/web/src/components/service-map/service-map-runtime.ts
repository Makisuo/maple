import type { ServicePlatform } from "@/api/warehouse/service-map"
import type { IconComponent } from "@/components/icons"
import { NodejsMonoIcon, NODEJS_MARK_PATH } from "@/components/icons/nodejs"
import { PythonIcon, PYTHON_MARK_PATH } from "@/components/icons/python"
import { BunIcon, BUN_MARK_PATH } from "@/components/icons/bun"
import { DenoIcon, DENO_MARK_PATH } from "@/components/icons/deno"
import { OpenjdkMonoIcon, OPENJDK_MARK_PATH } from "@/components/icons/openjdk"
import { RustIcon, RUST_MARK_PATH } from "@/components/icons/rust"
import { RubyIcon, RUBY_MARK_PATH } from "@/components/icons/ruby"
import { CloudflareMonoIcon, CLOUDFLARE_MARK_PATH } from "@/components/icons/cloudflare"

interface RuntimeGlyph {
	Icon: IconComponent | null
	path?: string
	short: string
	full: string
}

/**
 * `process.runtime.name` ⇒ the mark we draw for it. Values are normalized first
 * because the canonical OTel strings differ per SDK ("cpython", ".NET Core",
 * "OpenJDK Runtime Environment"), and self-instrumenters emit shorter aliases.
 *
 * Unknown values have no glyph. Known runtimes without SVG artwork use a short
 * wordmark; the 2D formatter below also preserves unknown runtime text.
 */
export function resolveRuntimeGlyph(rt: string): RuntimeGlyph | null {
	const key = rt.trim().toLowerCase()
	if (key.startsWith("openjdk") || key === "jvm" || key === "java")
		return { Icon: OpenjdkMonoIcon, path: OPENJDK_MARK_PATH, short: "jvm", full: "JVM" }
	if (key.startsWith(".net") || key === "dotnet" || key === "coreclr")
		return { Icon: null, short: "dotnet", full: ".NET" }
	switch (key) {
		case "nodejs":
		case "node":
			return { Icon: NodejsMonoIcon, path: NODEJS_MARK_PATH, short: "node", full: "Node.js" }
		case "bun":
			return { Icon: BunIcon, path: BUN_MARK_PATH, short: "bun", full: "Bun" }
		case "deno":
			return { Icon: DenoIcon, path: DENO_MARK_PATH, short: "deno", full: "Deno" }
		case "workerd":
			return {
				Icon: CloudflareMonoIcon,
				path: CLOUDFLARE_MARK_PATH,
				short: "workerd",
				full: "Cloudflare workerd",
			}
		case "rust":
			return { Icon: RustIcon, path: RUST_MARK_PATH, short: "rust", full: "Rust" }
		case "go":
		case "golang":
			return { Icon: null, short: "go", full: "Go" }
		case "python":
		case "cpython":
			return { Icon: PythonIcon, path: PYTHON_MARK_PATH, short: "python", full: "Python" }
		case "ruby":
		case "cruby":
			return { Icon: RubyIcon, path: RUBY_MARK_PATH, short: "ruby", full: "Ruby" }
		case "php":
			return { Icon: null, short: "php", full: "PHP" }
		case "edge-light":
			return { Icon: null, short: "edge", full: "Edge runtime" }
		case "fastly":
			return { Icon: null, short: "fastly", full: "Fastly Compute" }
		default:
			return null
	}
}

/**
 * The runtime the platform icon already implies is dropped rather than drawn
 * twice — a Cloudflare node running workerd gets one Cloudflare mark, not two.
 */
export function formatRuntime(
	rt: string | undefined,
	platform: ServicePlatform | undefined,
): RuntimeGlyph | null {
	if (!rt) return null
	if (platform === "cloudflare" && rt.toLowerCase() === "workerd") return null
	return resolveRuntimeGlyph(rt) ?? { Icon: null, short: rt, full: rt }
}
