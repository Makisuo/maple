import { PostgresTransactionId } from "@maple/domain"
import { sql } from "drizzle-orm"

/**
 * `.returning()` fragment that captures the Postgres transaction id of the
 * statement it's attached to. Cast to 32-bit `xid` (matching what Electric emits
 * on the replication stream) and to text so postgres.js/PGlite hand it back as a
 * plain string rather than a driver-specific bigint shape.
 *
 * Attach this to the mutating statement whose row Electric syncs; the TanStack DB
 * electric collection write handler returns the resulting txid to
 * `awaitTxId`, which resolves the optimistic mutation once that transaction
 * arrives on the shape stream — no flicker, no refetch.
 *
 * Because Maple's control-plane writes are single-statement implicit
 * transactions, capturing the txid on the write's own `.returning()` is exact.
 * If a write is ever wrapped in an explicit `db.transaction`, capture the txid
 * with a `SELECT pg_current_xact_id()::xid::text` inside that same transaction
 * instead.
 */
export const txidColumn = {
	txid: sql<string>`pg_current_xact_id()::xid::text`,
}

/**
 * Reads the txid from a `.returning(txidColumn)` result row. Returns `undefined`
 * when the row is missing so callers can degrade gracefully — the txid is an
 * optional response field; without it the client simply drops optimistic state
 * on the next synced update rather than on the precise transaction.
 */
export const readTxid = (
	rows: ReadonlyArray<{ readonly txid?: string | null }>,
): PostgresTransactionId | undefined => {
	const txid = rows[0]?.txid
	return txid == null ? undefined : PostgresTransactionId.make(txid)
}
