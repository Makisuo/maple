/**
 * `/local.md` — the agent-readable twin of `/local`.
 *
 * States the positioning in the first two lines so an answer engine that reads
 * nothing else still gets it right: a free, standalone observability stack for
 * local development that needs no account and no hosted service. The compose
 * comparison becomes a table; the guarantees and FAQ become sections.
 */
import type { APIRoute } from "astro"
import { blocks, docHeader, markdown, table } from "../lib/page-markdown"

const GITHUB_URL = "https://github.com/MapleTechLabs/maple"

export const GET: APIRoute = async ({ site }) => {
	const url = (path: string) => new URL(path, site ?? "https://maple.dev").toString()

	const compare = table(
		["", "The usual compose stack", "Maple Local"],
		[
			["Processes", "5 containers (collector, Jaeger, Prometheus, Loki, Grafana)", "1 process"],
			["Ports", ":4317 :4318 :16686 :9090 :3100 :3000", ":4318"],
			["UIs", "3 (Jaeger, Prometheus, Grafana)", "1"],
			["Config", "compose file + collector, scrape, Loki, and Grafana provisioning", "none"],
			[
				"Signals",
				"traces, metrics, logs (one backend each)",
				"traces, logs, metrics, errors, sessions, service map",
			],
			["Account", "none", "none"],
		],
	)

	const views = table(
		["View", "What it shows"],
		[
			["Traces", "Span search by service, duration, or error; full waterfalls with correlated logs"],
			["Logs", "Full-text search by service, severity, text, or trace id; log-pattern clustering"],
			["Metrics", "Every OTLP metric received, charted"],
			["Errors", "Error groups by fingerprint with sample traces and a timeseries"],
			["Sessions", "Browser sessions from the web SDK, with device and error filters"],
			["Service map", "Dependency edges with call counts, error rates, and latency"],
		],
	)

	return markdown(
		blocks(
			docHeader(
				"Maple Local",
				"A free, standalone observability stack for local development. One process on localhost receives OpenTelemetry, stores it, and serves a full dashboard and CLI — no Docker, no account, no cloud. It replaces the collector + Jaeger + Prometheus + Loki + Grafana compose file most repos keep for local telemetry, and it never requires the hosted Maple service.",
			),

			"## Install and run",
			[
				"```bash",
				"brew install Makisuo/tap/maple      # or: curl -fsSL https://maple.dev/cli/install | sh",
				"maple start                         # OTLP ingest + embedded store + dashboard on :4318",
				'export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"',
				"```",
			].join("\n"),
			"Any OpenTelemetry SDK works unmodified: the server speaks OTLP/HTTP on `POST /v1/{traces,logs,metrics}` with no auth header. Data persists in `~/.maple/data` between runs. Platforms: macOS (Apple Silicon and Intel) and Linux (x86_64 and arm64).",

			"## Instead of a compose file",
			compare,
			"Light refers to the running footprint — one process, one port, nothing to orchestrate. The download is not small: the embedded database engine is a few hundred megabytes on disk.",

			"## Standalone by design",
			[
				"- **No account, ever.** No sign-up, login, license key, or trial. `maple start` is the whole onboarding.",
				"- **Telemetry stays on loopback.** Ingest, storage, and every query run on 127.0.0.1. The dashboard page loads from local.maple.dev by default so UI fixes ship without a new binary; it only talks back to your local server. `maple start --offline` serves the UI from the binary too.",
				"- **Works with no internet.** With `--offline` everything comes out of the binary. The only other network call is a once-per-day check for a newer release — skipped for Homebrew installs, disabled with `MAPLE_NO_UPDATE_CHECK=1`.",
				"- **You own the files.** Everything lives under `~/.maple`. `maple archive` seals a day into Parquet queryable with DuckDB; uninstalling leaves the data directory in place.",
				"- **Source-available.** The whole platform is on GitHub under the Functional Source License, converting to Apache 2.0.",
			].join("\n"),

			"## The dashboard",
			views,

			"## The CLI",
			"The same binary is a query CLI. Every command runs against the local server and prints JSON by default (`--format table` for an aligned table, `--debug` to print the query). Examples:",
			[
				"```bash",
				"maple traces --service api --errors --since 5m    # the failing request's trace",
				'maple compare --around "2026-09-06 14:00:00"      # before vs. after a change',
				"maple diagnose api --since 15m                    # health, top errors, recent traces",
				'maple query "SELECT count() FROM traces"          # raw SQL against the local store',
				"```",
			].join("\n"),
			`Full command list: [CLI reference](${url("/docs/local-mode/cli-reference.md")}).`,

			"## FAQ",
			"### Do I need a Maple account?",
			"No. Nothing in Maple Local asks you to create one, now or later.",
			"### Does any telemetry leave my machine?",
			"No. Ingest, storage, and queries run on 127.0.0.1. The default dashboard page is served from local.maple.dev but only ever talks to your local server; `--offline` removes even that.",
			"### What does it replace?",
			"The docker compose stack used for local telemetry: an OpenTelemetry Collector, Jaeger, Prometheus, Loki, and Grafana.",
			"### How is it different from the hosted Maple service?",
			"Same engine and views, no account and no cloud. The hosted service adds multi-user access, alerting, retention at scale, and an MCP server for agents. Maple Local is complete on its own; the same CLI can talk to a hosted workspace with `maple auth login`, but nothing requires it.",
			"### What does it cost?",
			"Nothing. There is no paid tier of Maple Local and no usage limit.",

			"## Links",
			[
				`- [Documentation](${url("/docs/local-mode.md")})`,
				`- [CLI reference](${url("/docs/local-mode/cli-reference.md")})`,
				`- [Releases](${GITHUB_URL}/releases)`,
				`- [Source](${GITHUB_URL})`,
			].join("\n"),
		),
	)
}
