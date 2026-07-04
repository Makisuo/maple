// Re-export useful types from the underlying clients
export type { Row } from "@electric-sql/client"
export type { Txid } from "@tanstack/electric-db-collection"
// Core collection creation
export {
	COLLECTION_ERROR_STATE_CHANGED_EVENT,
	type CollectionStatus,
	createEffectCollection,
	type EffectCollection,
	effectElectricCollectionOptions,
	type EffectElectricCollectionUtils,
} from "./collection"
// Errors
export {
	AwaitTxIdError,
	DeleteError,
	ElectricCollectionError,
	InsertError,
	InvalidTxIdError,
	MaxRetriesExceededError,
	MissingTxIdError,
	OptimisticActionError,
	SyncConfigError,
	SyncError,
	TxIdTimeoutError,
	UpdateError,
} from "./errors"
// Optimistic Actions
export {
	type CollectionInput,
	type MutationContext,
	type MutationResultWithTxId,
	type OptimisticActionConfig,
	type OptimisticActionResult,
	optimisticAction,
} from "./optimistic-action"
// Types
export type {
	BackoffConfig,
	EffectDeleteHandler,
	EffectElectricCollectionConfig,
	EffectInsertHandler,
	EffectUpdateHandler,
} from "./types"
