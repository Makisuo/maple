#!/usr/bin/env bun
/**
 * Idempotent heal for `electric_publication_default`.
 *
 * Drizzle 0009 wraps CREATE PUBLICATION in WHEN OTHERS, so a migrate can record
 * as applied while the publication is empty. Electric then 503s unpublished
 * shapes. Call this after `db:migrate` from celld-dev, Compose, or the k8s Job.
 *
 *   DATABASE_URL=postgres://… bun run --cwd packages/db db:ensure-electric-publication
 */
import postgres from "postgres"
import { ELECTRIC_PUBLICATION, ELECTRIC_SYNCED_TABLES } from "../src/electric-publication"

const url = process.env.DATABASE_URL?.trim() || process.env.MAPLE_PG_URL?.trim()
if (!url) {
	throw new Error("DATABASE_URL or MAPLE_PG_URL is required")
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', "")}"`

const sql = postgres(url)
try {
	const existing = await sql`
		select 1 from pg_publication where pubname = ${ELECTRIC_PUBLICATION} limit 1
	`
	if (existing.length === 0) {
		await sql.unsafe(`CREATE PUBLICATION ${quoteIdent(ELECTRIC_PUBLICATION)}`)
	}

	for (const table of ELECTRIC_SYNCED_TABLES) {
		await sql.unsafe(`ALTER TABLE ${quoteIdent(table)} REPLICA IDENTITY FULL`)
		const member = await sql`
			select 1 from pg_publication_tables
			where pubname = ${ELECTRIC_PUBLICATION}
				and schemaname = 'public'
				and tablename = ${table}
			limit 1
		`
		if (member.length === 0) {
			await sql.unsafe(
				`ALTER PUBLICATION ${quoteIdent(ELECTRIC_PUBLICATION)} ADD TABLE ${quoteIdent(table)}`,
			)
		}
	}

	const members = await sql<{ tablename: string }>`
		select tablename from pg_publication_tables
		where pubname = ${ELECTRIC_PUBLICATION}
		order by 1
	`
	console.log(
		`electric publication ${ELECTRIC_PUBLICATION}: ${members.map((row) => row.tablename).join(", ")}`,
	)
} finally {
	await sql.end()
}
