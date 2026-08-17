// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { createTab, ensureStoredTab, renameTab } = vi.hoisted(() => ({
	createTab: vi.fn(() => "new-tab"),
	ensureStoredTab: vi.fn(),
	renameTab: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		onClick,
		search,
		to: _to,
		...props
	}: Omit<ComponentProps<"a">, "href"> & { search: { tab?: string }; to: string }) => (
		<a
			{...props}
			href={`/chat?tab=${search.tab ?? ""}`}
			data-tab={search.tab}
			onClick={(event) => {
				event.preventDefault()
				onClick?.(event)
			}}
		>
			{children}
		</a>
	),
}))

vi.mock("@maple/ui/components/ui/sheet", () => {
	const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		Sheet: Passthrough,
		SheetDescription: Passthrough,
		SheetHeader: Passthrough,
		SheetPopup: Passthrough,
		SheetTitle: Passthrough,
	}
})

vi.mock("@/hooks/use-chat-tabs", () => ({
	ensureStoredTab,
	useChatTabs: () => ({ createTab, renameTab }),
}))

vi.mock("./global-chat-content", () => ({
	GlobalChatContent: ({
		tabId,
		onFirstMessage,
	}: {
		tabId: string
		onFirstMessage?: (tabId: string, text: string) => void
	}) => (
		<div data-testid="conversation" data-tab={tabId}>
			<button type="button" onClick={() => onFirstMessage?.(tabId, "Investigate checkout latency")}>
				Send first message
			</button>
		</div>
	),
}))

import { GlobalChatPanel } from "./global-chat-panel"

afterEach(cleanup)

describe("GlobalChatPanel", () => {
	beforeEach(() => {
		createTab.mockClear()
		ensureStoredTab.mockClear()
		renameTab.mockClear()
	})

	it("creates and opens a fresh conversation from the AI sheet", async () => {
		const onOpenChange = vi.fn()
		render(<GlobalChatPanel orgId="org-1" onOpenChange={onOpenChange} />)

		expect((await screen.findByTestId("conversation")).dataset.tab).toBe("quick")

		fireEvent.click(screen.getByRole("button", { name: "New chat" }))

		expect(createTab).toHaveBeenCalledOnce()
		expect(screen.getByTestId("conversation").dataset.tab).toBe("new-tab")

		fireEvent.click(screen.getByRole("button", { name: "Send first message" }))
		expect(renameTab).toHaveBeenCalledWith("new-tab", "Investigate checkout latency")

		fireEvent.click(screen.getByRole("link", { name: "Open full page" }))
		expect(ensureStoredTab).toHaveBeenCalledWith("org-1", "new-tab", "New Chat")
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
