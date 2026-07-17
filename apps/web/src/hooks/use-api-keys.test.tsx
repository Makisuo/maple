// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PostgresTransactionId } from "@maple/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	const preload = vi.fn<() => Promise<void>>()
	const awaitTxId = vi.fn<(txid: number, timeout: number) => Promise<boolean>>()
	const runFork = vi.fn()
	return { preload, awaitTxId, runFork, collection: { preload, utils: { awaitTxId } } }
})

vi.mock("@/lib/collections/org-collections", () => ({
	getOrgCollections: () => ({ apiKeys: mocks.collection }),
	useActiveOrgId: () => "org_1",
	useCollectionsGeneration: () => 0,
}))
vi.mock("@/lib/registry", () => ({ mapleRuntime: { runFork: mocks.runFork } }))

import { useApiKeyMutationSync } from "./use-api-keys"

function Harness({ txid }: { txid: PostgresTransactionId | undefined }) {
	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	return (
		<button
			onClick={() => {
				prepareForMutation()
				void reconcileTxid(txid)
			}}
		>
			sync
		</button>
	)
}

describe("useApiKeyMutationSync", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.preload.mockResolvedValue(undefined)
		mocks.awaitTxId.mockResolvedValue(true)
	})
	afterEach(cleanup)

	it("starts the collection and reconciles a valid txid", async () => {
		render(<Harness txid={PostgresTransactionId.make("81234")} />)
		fireEvent.click(screen.getByRole("button", { name: "sync" }))

		await waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1))
		expect(mocks.awaitTxId).toHaveBeenCalledWith(81234, 30_000)
		expect(mocks.runFork).not.toHaveBeenCalled()
	})

	it("swallows reconciliation failures after the API write committed", async () => {
		mocks.awaitTxId.mockRejectedValueOnce(new Error("Electric timed out"))
		render(<Harness txid={PostgresTransactionId.make("81234")} />)
		fireEvent.click(screen.getByRole("button", { name: "sync" }))

		await waitFor(() => expect(mocks.runFork).toHaveBeenCalledTimes(1))
		expect(mocks.awaitTxId).toHaveBeenCalledWith(81234, 30_000)
	})

	it("does not wait when the API response has no txid", async () => {
		render(<Harness txid={undefined} />)
		fireEvent.click(screen.getByRole("button", { name: "sync" }))

		await waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1))
		expect(mocks.awaitTxId).not.toHaveBeenCalled()
	})
})
