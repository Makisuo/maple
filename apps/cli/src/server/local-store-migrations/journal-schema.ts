// Declarative shape of the coordinator-owned migration journal.
//
// The journal is untrusted JSON: it was written by some build of this CLI, not
// necessarily this one. Everything below used to be a hand-rolled parser in
// `local-store-migrations.ts` — `typeof` chains, `Number.isInteger` guards, and
// an `as string` on every field read. The shape is now declared once and the
// casts are gone; what remains imperative in that file are the cross-field
// invariants (phase x currentStepIndex x per-step status), which are a state
// machine rather than a struct.
//
// Decoding is synchronous and throwing to match the coordinator, which is plain
// TypeScript throw/catch code. `Schema.decodeUnknownEffect` is a one-line swap
// if that ever moves into Effect.
import { Effect, Schema, SchemaGetter } from "effect"
import { resolve } from "node:path"

/**
 * Rejecting unknown fields is not tidiness. A journal carrying a field this
 * build does not know about was written by a different build, and silently
 * dropping it would resume someone else's migration under our assumptions.
 */
const strict = { onExcessProperty: "error" } as const

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

/** A migration id is interpolated into filesystem paths; keep it path-safe. */
const migrationIdPattern = /^[A-Za-z0-9._-]+$/

/**
 * Paths are normalized on the way in so a journal written with a relative or
 * unnormalized path compares equal to the configured data directory. `resolve`
 * is idempotent on an absolute path, so the encoding side is a passthrough.
 */
const ResolvedPath = NonEmptyString.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform(resolve),
		encode: SchemaGetter.passthrough(),
	}),
)

/** Coordinator-owned transaction phases. */
export const MigrationPhaseSchema = Schema.Literals([
	"planned",
	"preflight-complete",
	"target-created",
	"copying",
	"copy-verified",
	"promotion-started",
	"promoted",
	"failed",
])

export type MigrationPhase = typeof MigrationPhaseSchema.Type

export const MigrationStepStatusSchema = Schema.Literals(["pending", "running", "verified", "completed"])

/**
 * A schema identity as persisted in a journal.
 *
 * `manifestDigest` and `projectRevision` are `optionalKey`, not `optional`: the
 * journal is JSON, where an absent field is an absent key rather than a present
 * `undefined`. That is also what lets the coordinator write them back without a
 * conditional spread.
 */
export const LocalSchemaIdentitySchema = Schema.Struct({
	version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	fingerprint: NonEmptyString,
	digest: Schema.String,
	manifestDigest: Schema.optionalKey(Schema.String),
	chdb: NonEmptyString,
	projectRevision: Schema.optionalKey(Schema.String),
})

/**
 * One edge in a migration chain.
 *
 * `state` and `progress` stay `Unknown` on purpose. The coordinator does not
 * interpret them; each module decodes its own through `decodeState` /
 * `decodeProgress`. Keeping that split is what lets a staged target be
 * abandoned when a module's persisted state is corrupt or its code is no
 * longer bindable.
 */
export const MigrationStepJournalSchema = Schema.Struct({
	id: NonEmptyString,
	moduleVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	from: LocalSchemaIdentitySchema,
	to: LocalSchemaIdentitySchema,
	status: MigrationStepStatusSchema,
	state: Schema.optionalKey(Schema.Unknown),
	progress: Schema.optionalKey(Schema.Unknown),
})

export const MigrationJournalSchema = Schema.Struct({
	formatVersion: Schema.Literal(2),
	migrationId: Schema.String.check(Schema.isPattern(migrationIdPattern)),
	phase: MigrationPhaseSchema,
	chain: Schema.Array(MigrationStepJournalSchema).check(Schema.isMinLength(1)),
	currentStepIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	sourceDataDir: ResolvedPath,
	sourceStoreId: NonEmptyString,
	sourceChdb: NonEmptyString,
	sourceFingerprint: NonEmptyString,
	// Asymmetric with `targetDigest` on purpose: the v0 legacy identity has no
	// digest at all (see LOCAL_SCHEMA_HISTORY), so a journal migrating away from
	// it carries an empty source digest. A target is always a known schema.
	sourceDigest: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
	sourceVersion: Schema.Int,
	targetDataDir: ResolvedPath,
	targetStoreId: NonEmptyString,
	targetChdb: NonEmptyString,
	targetFingerprint: NonEmptyString,
	targetDigest: NonEmptyString,
	targetVersion: Schema.Int,
	cutoffAt: NonEmptyString,
	createdAt: NonEmptyString,
	failure: Schema.optionalKey(Schema.String),
})

const decodeJournal = Schema.decodeUnknownSync(MigrationJournalSchema, strict)

/**
 * Decode the journal envelope. Cross-field chain invariants are asserted by the
 * coordinator after this returns; this only establishes the shape.
 */
export const decodeMigrationJournal = (value: unknown): typeof MigrationJournalSchema.Type =>
	decodeJournal(value)
