#!/usr/bin/env bun
/**
 * @maple/clickhouse-cli — apply Maple's ClickHouse schema standalone.
 *
 * Usage:
 *   bunx @maple/clickhouse-cli@latest <command> [flags]
 *
 * Commands:
 *   apply       Apply unapplied migrations against the target ClickHouse.
 *   status      Print applied migrations + count of pending ones.
 *   dry-run     Print the DDL that would run, no execution.
 *   version     Print bundled migration count + revision hash.
 *   help        Show this help.
 *
 * Connection flags:
 *   --url       Required. e.g. https://my-ch.example.com
 *   --user      Default: default
 *   --password  Required if the user has a password set.
 *   --database  Default: default
 *
 * Env-var fallbacks (handy in CI):
 *   MAPLE_CH_URL, MAPLE_CH_USER, MAPLE_CH_PASSWORD, MAPLE_CH_DATABASE
 */

import {
	applyMigrations,
	bundledMigrations,
	dryRun,
	listApplied,
	pendingMigrations,
	pendingSchemaFeatures,
} from "./apply"
import { ClickHouseError, ping, type ClickHouseConfig } from "./client"
import { clickHouseProjectRevision, clickHouseSchemaVersion } from "@maple/domain/clickhouse"

const HELP = `@maple/clickhouse-cli — apply Maple's ClickHouse schema

USAGE
  maple-ch <command> [--url <url>] [--user <user>] [--password <pw>] [--database <db>]

COMMANDS
  apply       Apply any unapplied migrations.
  status      Show applied + pending migrations.
  dry-run     Print DDL that would run, no execution.
  version     Print bundled migration count + revision.
  help        Show this help.

CONNECTION
  --url        Default: env MAPLE_CH_URL
  --user       Default: env MAPLE_CH_USER or "default"
  --password   Default: env MAPLE_CH_PASSWORD
  --database   Default: env MAPLE_CH_DATABASE or "default"

EXAMPLES
  bunx @maple/clickhouse-cli@latest apply --url=https://my.ch:8443 --user=maple --password=$PASS
  bunx @maple/clickhouse-cli@latest status
  bunx @maple/clickhouse-cli@latest dry-run | less
`

async function main(argv: ReadonlyArray<string>): Promise<number> {
	const [command, ...rest] = argv
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP)
		return 0
	}

	if (command === "version") {
		process.stdout.write(
			`bundled migrations: ${bundledMigrations.length}\n` +
				`schema version:     ${clickHouseSchemaVersion}\n` +
				`project revision:   ${clickHouseProjectRevision}\n` +
				`\nNote: this CLI applies the ClickHouse schema but does NOT mark the org\n` +
				`ready in Maple (it never writes Maple's application database). After applying, open\n` +
				`Settings → BYO Backend → ClickHouse (or call the schemaDiff endpoint) so\n` +
				`Maple records schema version ${clickHouseSchemaVersion} and the ingest gateway routes here.\n`,
		)
		return 0
	}

	const flags = parseFlags(rest)
	const config: ClickHouseConfig = {
		url: flags.url ?? process.env.MAPLE_CH_URL ?? "",
		user: flags.user ?? process.env.MAPLE_CH_USER ?? "default",
		password: flags.password ?? process.env.MAPLE_CH_PASSWORD ?? "",
		database: flags.database ?? process.env.MAPLE_CH_DATABASE ?? "default",
	}

	if (!config.url) {
		process.stderr.write("error: --url (or MAPLE_CH_URL) is required\n\n")
		process.stderr.write(HELP)
		return 2
	}

	switch (command) {
		case "apply":
			return await runApply(config)
		case "status":
			return await runStatus(config)
		case "dry-run":
			return await runDryRun(config)
		default:
			process.stderr.write(`unknown command: ${command}\n\n`)
			process.stderr.write(HELP)
			return 2
	}
}

async function runApply(config: ClickHouseConfig): Promise<number> {
	try {
		// Connectivity smoke-test up front so credential errors surface
		// before any DDL hits the wire.
		const version = await ping(config)
		process.stdout.write(
			`connected to ClickHouse ${version} as ${config.user}@${config.url}/${config.database}\n`,
		)

		const result = await applyMigrations(config)
		for (const m of result.skipped) {
			process.stdout.write(
				`  skip   ${m.version}  ${m.description}${m.reason ? ` (${m.reason})` : ""}\n`,
			)
		}
		for (const m of result.applied) {
			process.stdout.write(`  apply  ${m.version}  ${m.description}\n`)
		}
		for (const feature of result.skippedFeatures) {
			process.stdout.write(`  skip   feature:${feature.id}  ${feature.reason}\n`)
		}
		for (const feature of result.appliedFeatures) {
			process.stdout.write(`  apply  feature:${feature.id}  ${feature.description}\n`)
		}
		process.stdout.write(
			`\n${result.applied.length} migrations and ${result.appliedFeatures.length} features applied.\n`,
		)
		return 0
	} catch (err) {
		return reportError(err)
	}
}

async function runStatus(config: ClickHouseConfig): Promise<number> {
	try {
		const applied = await listApplied(config)
		const pending = await pendingMigrations(config)
		const features = await pendingSchemaFeatures(config)
		process.stdout.write("applied:\n")
		if (applied.length === 0) process.stdout.write("  (none)\n")
		for (const r of applied) {
			process.stdout.write(`  ${r.version}  ${r.applied_at}  ${r.description}\n`)
		}
		process.stdout.write("\npending:\n")
		if (pending.length === 0) process.stdout.write("  (none)\n")
		for (const m of pending) {
			process.stdout.write(`  ${m.version}  ${m.description}\n`)
		}
		process.stdout.write("\nfeatures:\n")
		if (features.length === 0) process.stdout.write("  (all reconciled)\n")
		for (const feature of features) {
			process.stdout.write(
				`  ${feature.state.padEnd(11)} feature:${feature.id}  ${feature.reason ?? feature.description}\n`,
			)
		}
		return 0
	} catch (err) {
		return reportError(err)
	}
}

async function runDryRun(config: ClickHouseConfig): Promise<number> {
	try {
		const plan = await dryRun(config)
		const features = (await pendingSchemaFeatures(config)).filter(
			(feature) => feature.state === "pending",
		)
		if (plan.length === 0 && features.length === 0) {
			process.stdout.write("nothing to apply — schema is up to date.\n")
			return 0
		}
		for (const m of plan) {
			process.stdout.write(`-- migration ${m.version}\n`)
			for (const stmt of m.statements) {
				process.stdout.write(stmt)
				process.stdout.write(";\n")
			}
		}
		for (const feature of features) {
			process.stdout.write(`-- feature ${feature.id}: ${feature.description}\n`)
			if (feature.statements.length === 0) {
				process.stdout.write(`-- ${feature.reason ?? "bookkeeping only"}\n`)
			}
			for (const statement of feature.statements) {
				process.stdout.write(statement)
				process.stdout.write(";\n")
			}
		}
		return 0
	} catch (err) {
		return reportError(err)
	}
}

function reportError(err: unknown): number {
	if (err instanceof ClickHouseError) {
		process.stderr.write(`ClickHouse rejected: ${err.message}\n`)
		// 401/403 -> bad creds, 4xx -> bad statement, 5xx -> upstream
		return err.status >= 500 ? 4 : 3
	}
	if (err instanceof Error) {
		process.stderr.write(`error: ${err.message}\n`)
		return 1
	}
	process.stderr.write(`error: ${String(err)}\n`)
	return 1
}

interface Flags {
	readonly url?: string
	readonly user?: string
	readonly password?: string
	readonly database?: string
}

function parseFlags(args: ReadonlyArray<string>): Flags {
	const flags: Record<string, string> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? ""
		if (!a.startsWith("--")) {
			continue
		}
		const eq = a.indexOf("=")
		if (eq >= 0) {
			flags[a.slice(2, eq)] = a.slice(eq + 1)
		} else {
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith("--")) {
				flags[a.slice(2)] = next
				i++
			} else {
				flags[a.slice(2)] = "true"
			}
		}
	}
	return flags as Flags
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(
			`unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		process.exit(1)
	},
)
