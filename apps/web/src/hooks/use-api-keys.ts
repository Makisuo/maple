import type { PostgresTransactionId } from "@maple/domain"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { useLiveQuery } from "@tanstack/react-db"
import { Effect } from "effect"
import { useCallback, useMemo } from "react"
import { rowToV2ApiKey } from "@/lib/collections/api-keys"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"
import { mapleRuntime } from "@/lib/registry"

const TXID_SYNC_TIMEOUT_MS = 30_000

const logCollectionSyncFailure = (phase: "start" | "reconcile", error: unknown): void => {
	mapleRuntime.runFork(
		Effect.logWarning("API-key Electric reconciliation failed").pipe(
			Effect.annotateLogs({ phase, error: error instanceof Error ? error.message : String(error) }),
		),
	)
}

export function useApiKeysCollection() {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	return useMemo(
		() => getOrgCollections(orgKey).apiKeys,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)
}

export function useApiKeysList(): {
	readonly keys: ReadonlyArray<V2ApiKey>
	readonly isLoading: boolean
	readonly isError: boolean
} {
	const collection = useApiKeysCollection()
	const {
		data: rows,
		isLoading,
		isError,
	} = useLiveQuery(
		(q) => q.from({ key: collection }).orderBy(({ key }) => key.created_at, "desc"),
		[collection],
	)
	const keys = useMemo(() => (rows ?? []).map(rowToV2ApiKey), [rows])
	return { keys, isLoading: isLoading && keys.length === 0, isError }
}

/**
 * Starts the shape before a v2 write, then lets callers reconcile the committed
 * write by txid. Reconciliation is deliberately best-effort: once create/roll
 * returns a secret, a later Electric timeout must never turn that committed API
 * operation into a UI failure or hide the one-time secret.
 */
export function useApiKeyMutationSync(): {
	readonly prepareForMutation: () => void
	readonly reconcileTxid: (txid: PostgresTransactionId | undefined) => Promise<void>
} {
	const collection = useApiKeysCollection()

	const prepareForMutation = useCallback(() => {
		void collection.preload().catch((error) => logCollectionSyncFailure("start", error))
	}, [collection])

	const reconcileTxid = useCallback(
		async (txid: PostgresTransactionId | undefined): Promise<void> => {
			if (txid === undefined) return
			const parsed = Number(txid)
			try {
				await collection.utils.awaitTxId(parsed, TXID_SYNC_TIMEOUT_MS)
			} catch (error) {
				logCollectionSyncFailure("reconcile", error)
			}
		},
		[collection],
	)

	return { prepareForMutation, reconcileTxid }
}
