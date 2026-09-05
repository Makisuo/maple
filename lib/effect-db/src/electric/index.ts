// Re-export useful types from the underlying clients
export type { Row } from "@electric-sql/client"
export type { Txid } from "@tanstack/electric-db-collection"
// Core collection creation
export {
	COLLECTION_ERROR_STATE_CHANGED_EVENT,
	COLLECTION_SYNC_FAILED_EVENT,
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
	InsertError,
	InvalidTxIdError,
	MissingTxIdError,
	TxIdTimeoutError,
	UpdateError,
} from "./errors"
// Types
export type {
	BackoffConfig,
	EffectDeleteHandler,
	EffectElectricCollectionConfig,
	EffectInsertHandler,
	EffectUpdateHandler,
} from "./types"
