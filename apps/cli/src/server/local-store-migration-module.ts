// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import type { Chdb } from "./chdb"
import type { LocalSchemaIdentity } from "./schema-identity"
import type {
	MigrationPhase,
	MigrationStepJournalSchema,
	MigrationStepStatus,
} from "./local-store-migrations/journal-schema"

/** Coordinator-owned transaction phases. Modules may report progress, but
 * only the coordinator advances this top-level state machine. Both unions are
 * derived from the journal schema so the persisted form and the in-memory type
 * cannot drift. */
export type { MigrationPhase, MigrationStepStatus }

export type StateDisposition =
	| "preserve-exact"
	| "copy-transform"
	| "rebuild-complete"
	| "rebuild-within-retention-horizon"
	| "retain-as-legacy-rollback-only"
	| "invalidate"
	| "discard-with-confirmation"
	| "unsupported"

export interface MigrationOperation {
	readonly id: string
	readonly description: string
	readonly requiresQuiescence: boolean
	/** Optional human-facing phase hint; the coordinator does not trust it for
	 * transaction transitions. */
	readonly phase?: Exclude<MigrationPhase, "failed" | "promoted">
}

export interface StateDispositionEntry {
	readonly name: string
	readonly classification: "authoritative" | "derived" | "ephemeral" | "operational" | "unknown"
	readonly disposition: StateDisposition
	readonly guarantee: string
	readonly preservationInterval?: string
	readonly sourceRetentionDays?: number
	readonly targetRetentionDays?: number
}

/** The persisted binding for one edge in a migration chain. The identities
 * are copied into the journal so a later build cannot reinterpret an old
 * step through its current-schema constant. */
export type MigrationStepJournal = typeof MigrationStepJournalSchema.Type

export interface MigrationDbOptions {
	readonly schemaSql?: string
	readonly bootstrapSchema?: boolean
}

export interface MigrationStepUpdate {
	readonly state?: unknown
	readonly progress?: unknown
}

/** Generic services supplied by the coordinator. A module can use these to
 * inspect its input, construct its target, and durably persist typed state;
 * it does not get to mutate the coordinator phase or the promotion journal. */
export interface MigrationModuleContext {
	readonly dataDir: string
	readonly sourceDataDir: string
	readonly targetDataDir: string
	readonly source: LocalSchemaIdentity
	readonly target: LocalSchemaIdentity
	readonly cutoffAt: string
	readonly step: MigrationStepJournal
	readonly openSource: <A>(fn: (db: Chdb) => A | Promise<A>, options?: MigrationDbOptions) => Promise<A>
	readonly openTarget: <A>(fn: (db: Chdb) => A | Promise<A>, options?: MigrationDbOptions) => Promise<A>
	/** Close the coordinator-owned chDB session before a module performs a
	 * filesystem-level clone of a clean, stopped store. */
	readonly closeStores: () => Promise<void>
	readonly ensureCapacity: () => Promise<void>
	readonly saveStep: (update: MigrationStepUpdate) => Promise<void>
}

/**
 * A compile-time migration module. The registry is intentionally static: a
 * migration must ship with the CLI so its code, schema identities, and tests
 * are reviewed together. The coordinator owns transaction safety; modules own
 * transition-specific data movement and semantic verification.
 */
export interface LocalStoreMigrationModule<State = unknown, Progress = unknown> {
	readonly id: string
	/** Bump this when executable behavior or persisted state semantics change;
	 * prose/disposition wording is intentionally not part of the resume key. */
	readonly moduleVersion: number
	readonly description: string
	readonly from: Readonly<LocalSchemaIdentity>
	readonly to: Readonly<LocalSchemaIdentity>
	readonly operations: ReadonlyArray<MigrationOperation>
	readonly dispositions: ReadonlyArray<StateDispositionEntry>
	/** Decode values restored from the untrusted JSON journal before handing them
	 * to executable module code. A decoder must reject malformed or unknown
	 * state rather than manufacturing defaults. */
	decodeState(value: unknown): State
	decodeProgress(value: unknown): Progress | undefined
	preflight(context: MigrationModuleContext): Promise<State>
	prepareTarget(context: MigrationModuleContext, state: State): Promise<State>
	apply(context: MigrationModuleContext, state: State, progress: Progress | undefined): Promise<Progress>
	verify(context: MigrationModuleContext, state: State, progress: Progress): Promise<void>
	recover(
		context: MigrationModuleContext,
		state: State | undefined,
		progress: Progress | undefined,
	): Promise<{ readonly state?: State; readonly progress?: Progress }>
}

/** The registry is heterogeneous at runtime; the coordinator erases the
 * module-specific state types only at this boundary. Each concrete module
 * remains strongly typed internally. */
export type AnyLocalStoreMigrationModule = LocalStoreMigrationModule<any, any>
export type LocalStoreMigration = AnyLocalStoreMigrationModule
