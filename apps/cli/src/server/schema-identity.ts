import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import schemaV1Sql from "./schema/local-schema-v1.sql" with { type: "text" }
import schemaV2Sql from "./schema/local-schema-v2.sql" with { type: "text" }
import schemaV3Sql from "./schema/local-schema-v3.sql" with { type: "text" }
import schemaV4Sql from "./schema/local-schema-v4.sql" with { type: "text" }
import schemaV5Sql from "./schema/local-schema-v5.sql" with { type: "text" }
import schemaV6Sql from "./schema/local-schema-v6.sql" with { type: "text" }
import schemaV7Sql from "./schema/local-schema-v7.sql" with { type: "text" }
import schemaV8Sql from "./schema/local-schema-v8.sql" with { type: "text" }
import schemaV9Sql from "./schema/local-schema-v9.sql" with { type: "text" }
import schemaV10Sql from "./schema/local-schema-v10.sql" with { type: "text" }
import schemaV11Sql from "./schema/local-schema-v11.sql" with { type: "text" }
import schemaV12Sql from "./schema/local-schema-v12.sql" with { type: "text" }
import schemaV13Sql from "./schema/local-schema-v13.sql" with { type: "text" }
import schemaV14Sql from "./schema/local-schema-v14.sql" with { type: "text" }
import schemaV15Sql from "./schema/local-schema-v15.sql" with { type: "text" }
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"
import { CHDB_VERSION } from "../version"

export { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"

/**
 * Local-store schema version.
 *
 * Version 0 is the fingerprint-only legacy store represented by the recovery
 * procedure from issue #297. Any future structural DDL change must increment
 * this value and add a registered migration or an explicit unsupported edge.
 */
export { LOCAL_SCHEMA_VERSION }
export const LEGACY_LOCAL_SCHEMA_VERSION = 0 as const

export const LEGACY_SCHEMA_PROJECT_REVISION =
	"d58ce4a83d3ad3f3a29b9bb972272b757547ae793c050194354454634f3abccd"
export const LEGACY_SCHEMA_FINGERPRINT = "428701854f9fd30e"

export const CURRENT_SCHEMA_PROJECT_REVISION =
	"20753c5593ff6ab808b536d455b944d5cc300ae0eed841dfa951ff998dcefbaf"
/** Revision recorded by the issue-297 recovery report. The refreshed upstream
 * generator currently emits CURRENT_SCHEMA_PROJECT_REVISION; the structural
 * fingerprint is the compatibility identity used by the migration. */
export const ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION =
	"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91"
export const LOCAL_SCHEMA_SQL = schemaSql
export const SCHEMA_FINGERPRINT = fingerprintSchema(schemaSql)
export const SCHEMA_DIGEST = digestSchema(schemaSql)
export const LOCAL_SCHEMA_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaSql)
export const LOCAL_SCHEMA_MANIFEST_DIGEST = LOCAL_SCHEMA_MANIFEST.digest
/**
 * Immutable per-version DDL and manifest snapshots.
 *
 * A historical edge must keep constructing and verifying the schema it was
 * written for: when v10 ships, v8 -> v9 must still produce v9 rather than
 * silently retargeting whatever the generator currently emits. The SQL is
 * imported literally because Bun resolves text imports statically; everything
 * derived from it is built once, here.
 */
const SNAPSHOT_SQL: ReadonlyArray<string> = [
	schemaV1Sql,
	schemaV2Sql,
	schemaV3Sql,
	schemaV4Sql,
	schemaV5Sql,
	schemaV6Sql,
	schemaV7Sql,
	schemaV8Sql,
	schemaV9Sql,
	schemaV10Sql,
	schemaV11Sql,
	schemaV12Sql,
	schemaV13Sql,
	schemaV14Sql,
	schemaV15Sql,
]

export interface LocalSchemaSnapshot {
	readonly version: number
	readonly sql: string
	readonly manifest: LocalSchemaManifest
	readonly manifestDigest: string
}

/** Indexed by schema version; index 0 is the fingerprint-only legacy store, which has no DDL. */
export const LOCAL_SCHEMA_SNAPSHOTS: ReadonlyArray<LocalSchemaSnapshot | undefined> = Object.freeze([
	undefined,
	...SNAPSHOT_SQL.map((sql, index) => {
		const manifest = buildLocalSchemaManifest(sql)
		return Object.freeze({ version: index + 1, sql, manifest, manifestDigest: manifest.digest })
	}),
])

const snapshotAt = (version: number): LocalSchemaSnapshot => {
	const snapshot = LOCAL_SCHEMA_SNAPSHOTS[version]
	if (!snapshot) throw new Error(`no bundled DDL snapshot for local schema version ${version}`)
	return snapshot
}

export const LOCAL_SCHEMA_V1_SQL = snapshotAt(1).sql
export const LOCAL_SCHEMA_V1_MANIFEST = snapshotAt(1).manifest
export const LOCAL_SCHEMA_V2_SQL = snapshotAt(2).sql
export const LOCAL_SCHEMA_V2_MANIFEST = snapshotAt(2).manifest
export const LOCAL_SCHEMA_V3_SQL = snapshotAt(3).sql
export const LOCAL_SCHEMA_V3_MANIFEST = snapshotAt(3).manifest
export const LOCAL_SCHEMA_V4_SQL = snapshotAt(4).sql
export const LOCAL_SCHEMA_V4_MANIFEST = snapshotAt(4).manifest
export const LOCAL_SCHEMA_V5_SQL = snapshotAt(5).sql
export const LOCAL_SCHEMA_V5_MANIFEST = snapshotAt(5).manifest
export const LOCAL_SCHEMA_V6_SQL = snapshotAt(6).sql
export const LOCAL_SCHEMA_V6_MANIFEST = snapshotAt(6).manifest
export const LOCAL_SCHEMA_V7_SQL = snapshotAt(7).sql
export const LOCAL_SCHEMA_V7_MANIFEST = snapshotAt(7).manifest
export const LOCAL_SCHEMA_V8_SQL = snapshotAt(8).sql
export const LOCAL_SCHEMA_V8_MANIFEST = snapshotAt(8).manifest
export const LOCAL_SCHEMA_V9_SQL = snapshotAt(9).sql
export const LOCAL_SCHEMA_V9_MANIFEST = snapshotAt(9).manifest
export const LOCAL_SCHEMA_V10_SQL = snapshotAt(10).sql
export const LOCAL_SCHEMA_V10_MANIFEST = snapshotAt(10).manifest
export const LOCAL_SCHEMA_V11_SQL = snapshotAt(11).sql
export const LOCAL_SCHEMA_V11_MANIFEST = snapshotAt(11).manifest
export const LOCAL_SCHEMA_V12_SQL = snapshotAt(12).sql
export const LOCAL_SCHEMA_V12_MANIFEST = snapshotAt(12).manifest
export const LOCAL_SCHEMA_V13_SQL = snapshotAt(13).sql
export const LOCAL_SCHEMA_V13_MANIFEST = snapshotAt(13).manifest
export const LOCAL_SCHEMA_V14_SQL = snapshotAt(14).sql
export const LOCAL_SCHEMA_V14_MANIFEST = snapshotAt(14).manifest
export const LOCAL_SCHEMA_V15_SQL = snapshotAt(15).sql
export const LOCAL_SCHEMA_V15_MANIFEST = snapshotAt(15).manifest

export interface LocalSchemaIdentity {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest?: string
	readonly chdb: string
	readonly projectRevision?: string
}

/**
 * Per-version identities, frozen and read straight from the append-only
 * history. Historical migration edges must never point at
 * CURRENT_LOCAL_SCHEMA: when v10 ships, v0 -> v1 must still construct and verify
 * v1 rather than silently changing its destination.
 */
const identityAt = (version: number): LocalSchemaIdentity => {
	const entry = LOCAL_SCHEMA_HISTORY[version]
	if (!entry || entry.version !== version)
		throw new Error(`local schema history has no entry for version ${version}`)
	return Object.freeze({
		version: entry.version,
		fingerprint: entry.fingerprint,
		digest: entry.digest,
		manifestDigest: entry.manifestDigest,
		chdb: CHDB_VERSION,
		projectRevision: entry.projectRevision,
	})
}

export const LOCAL_SCHEMA_V1 = identityAt(1)
export const LOCAL_SCHEMA_V2 = identityAt(2)
export const LOCAL_SCHEMA_V3 = identityAt(3)
export const LOCAL_SCHEMA_V4 = identityAt(4)
export const LOCAL_SCHEMA_V5 = identityAt(5)
export const LOCAL_SCHEMA_V6 = identityAt(6)
export const LOCAL_SCHEMA_V7 = identityAt(7)
export const LOCAL_SCHEMA_V8 = identityAt(8)
export const LOCAL_SCHEMA_V9 = identityAt(9)
export const LOCAL_SCHEMA_V10 = identityAt(10)
export const LOCAL_SCHEMA_V11 = identityAt(11)
export const LOCAL_SCHEMA_V12 = identityAt(12)
export const LOCAL_SCHEMA_V13 = identityAt(13)
export const LOCAL_SCHEMA_V14 = identityAt(14)
export const LOCAL_SCHEMA_V15 = identityAt(15)

export const CURRENT_LOCAL_SCHEMA: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_VERSION,
	fingerprint: SCHEMA_FINGERPRINT,
	digest: SCHEMA_DIGEST,
	manifestDigest: LOCAL_SCHEMA_MANIFEST_DIGEST,
	chdb: CHDB_VERSION,
	projectRevision: CURRENT_SCHEMA_PROJECT_REVISION,
})

export const LEGACY_LOCAL_SCHEMA: LocalSchemaIdentity = {
	version: LEGACY_LOCAL_SCHEMA_VERSION,
	fingerprint: LEGACY_SCHEMA_FINGERPRINT,
	digest: "",
	chdb: CHDB_VERSION,
	projectRevision: LEGACY_SCHEMA_PROJECT_REVISION,
}

export const identityLabel = (identity: Pick<LocalSchemaIdentity, "version" | "fingerprint">): string =>
	`v${identity.version} (${identity.fingerprint})`
