// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./dropdown-menu"

afterEach(cleanup)

// Base UI's GroupLabel throws `MenuGroupContext is missing` (production error
// #31) outside a Group, which surfaces as a full error-boundary crash rather
// than a warning. Only opening the menu exercises it.
const open = () => fireEvent.click(screen.getByRole("button", { name: "Open" }))

describe("dropdown menu labels", () => {
	it("renders a bare label without throwing", () => {
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuLabel>Section</DropdownMenuLabel>
					<DropdownMenuItem>Only action</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)

		open()
		expect(screen.getByText("Section")).toBeDefined()
		expect(screen.getByRole("menuitem", { name: "Only action" })).toBeDefined()
	})

	it("lets the enclosing group own the label, so grouped menus keep aria-labelledby", () => {
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Section</DropdownMenuLabel>
						<DropdownMenuItem>Only action</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		)

		open()
		const group = screen.getByRole("group")
		const label = screen.getByText("Section")
		expect(group.getAttribute("aria-labelledby")).toBe(label.id)
		// The self-wrapping guard must not fire here — one group, not two.
		expect(screen.getAllByRole("group")).toHaveLength(1)
	})

	it("treats a radio group as a group too", () => {
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>Open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuRadioGroup value="a">
						<DropdownMenuLabel>Sort by</DropdownMenuLabel>
						<DropdownMenuRadioItem value="a">Name</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		)

		open()
		const label = screen.getByText("Sort by")
		expect(screen.getByRole("group").getAttribute("aria-labelledby")).toBe(label.id)
		expect(screen.getAllByRole("group")).toHaveLength(1)
	})
})
