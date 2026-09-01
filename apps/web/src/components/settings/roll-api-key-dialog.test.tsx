// @vitest-environment jsdom
// TEST-SEAM: the atom client and mutation-sync hooks are process-global wiring
// with no instance-level injection seam, so they are replaced at the module
// boundary and the dialog is exercised through its rendered controls.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2ApiKey } from "@maple/domain/http/v2"

/** What the roll mutation resolves to — only the fields this dialog reads. */
interface RolledKey {
	readonly secret: string
	readonly txid: string
}
type RollResult = Exit.Exit<RolledKey, never>

const rollMutation = vi.fn<() => Promise<RollResult>>()
vi.mock("@/lib/effect-atom", () => ({ useAtomSet: () => rollMutation }))
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: () => ({}) },
}))
vi.mock("@/hooks/use-api-keys", () => ({
	useApiKeyMutationSync: () => ({
		prepareForMutation: () => {},
		reconcileTxid: async () => {},
	}),
}))
vi.mock("./api-key-secret-reveal", () => ({
	ApiKeySecretReveal: ({ secret }: { secret: string }) => <div data-testid="secret">{secret}</div>,
}))

import { RollApiKeyDialog } from "./roll-api-key-dialog"

const apiKey = Schema.decodeUnknownSync(V2ApiKey)({
	id: "key_aXwpxqBkqtYwtBtmsGbR41",
	object: "api_key",
	name: "ci-pipeline",
	description: null,
	key_prefix: "maple_ak_9f2c",
	kind: "standard",
	scopes: null,
	revoked: false,
	revoked_at: null,
	last_used_at: null,
	expires_at: null,
	created_at: "2026-07-01T12:00:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	created_by_email: null,
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("RollApiKeyDialog", () => {
	it("refuses every dismissal path while the roll is in flight, then reveals the secret", async () => {
		let resolveRoll: ((value: RollResult) => void) | undefined
		rollMutation.mockReturnValue(
			new Promise((resolve) => {
				resolveRoll = resolve
			}),
		)
		const onOpenChange = vi.fn()
		render(<RollApiKeyDialog open onOpenChange={onOpenChange} apiKey={apiKey} />)

		fireEvent.click(screen.getByRole("button", { name: "Roll key" }))

		// The server may already have revoked the old key: closing here (the
		// built-in close button, Escape) would drop the one-time replacement
		// secret, or hand it to the next key's dialog.
		fireEvent.click(screen.getByRole("button", { name: "Close" }))
		fireEvent.keyDown(document.body, { key: "Escape" })
		expect(onOpenChange).not.toHaveBeenCalledWith(false)

		resolveRoll?.(Exit.succeed({ secret: "maple_ak_new_secret", txid: "42" }))
		expect((await screen.findByTestId("secret")).textContent).toBe("maple_ak_new_secret")

		// Once the secret is on screen, closing works again (footer + built-in
		// close button both render now — either dismisses).
		const closeButton = screen.getAllByRole("button", { name: "Close" })[0]
		expect(closeButton).toBeDefined()
		if (closeButton) fireEvent.click(closeButton)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
