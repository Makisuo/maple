import { describe, expect, it } from "vitest"
import { deriveContainerAttributes, type ContainerProbe } from "./container.js"

const FULL_ID = "a".repeat(64)
const OTHER_ID = "b".repeat(64)

const probe = (overrides: Partial<ContainerProbe>): ContainerProbe => ({
	exists: () => false,
	readFile: () => {
		throw new Error("ENOENT")
	},
	hostname: () => "my-laptop",
	...overrides,
})

describe("deriveContainerAttributes", () => {
	it("returns nothing outside a container", () => {
		expect(deriveContainerAttributes(probe({}))).toEqual({})
	})

	it("stamps container.runtime from /.dockerenv even without an id", () => {
		expect(deriveContainerAttributes(probe({ exists: (p) => p === "/.dockerenv" }))).toEqual({
			"container.runtime": "docker",
		})
	})

	it("prefers the mountinfo id — the cgroup-v2 private-namespace case", () => {
		const attrs = deriveContainerAttributes(
			probe({
				exists: (p) => p === "/.dockerenv",
				readFile: (path) =>
					path === "/proc/self/mountinfo"
						? `1573 1572 0:113 / / rw - overlay overlay rw\n1600 1573 254:1 /var/lib/docker/containers/${FULL_ID}/resolv.conf /etc/resolv.conf rw`
						: "0::/",
			}),
		)
		expect(attrs).toEqual({ "container.runtime": "docker", "container.id": FULL_ID })
	})

	it("falls back to /proc/self/cgroup on cgroup v1", () => {
		const attrs = deriveContainerAttributes(
			probe({
				exists: (p) => p === "/.dockerenv",
				readFile: (path) => {
					if (path === "/proc/self/cgroup") return `12:pids:/docker/${OTHER_ID}\n`
					throw new Error("ENOENT")
				},
			}),
		)
		expect(attrs["container.id"]).toBe(OTHER_ID)
	})

	it("falls back to a 12-hex hostname only inside Docker", () => {
		const inDocker = deriveContainerAttributes(
			probe({ exists: (p) => p === "/.dockerenv", hostname: () => "0123456789ab" }),
		)
		expect(inDocker["container.id"]).toBe("0123456789ab")

		// A bare 12-hex hostname on a non-Docker host must not fabricate identity.
		const outside = deriveContainerAttributes(probe({ hostname: () => "0123456789ab" }))
		expect(outside).toEqual({})
	})

	it("ignores a user-set hostname that isn't a short id", () => {
		const attrs = deriveContainerAttributes(
			probe({ exists: (p) => p === "/.dockerenv", hostname: () => "checkout-worker" }),
		)
		expect(attrs).toEqual({ "container.runtime": "docker" })
	})

	it("swallows probe failures instead of throwing", () => {
		const attrs = deriveContainerAttributes(
			probe({
				exists: () => {
					throw new Error("EACCES")
				},
				hostname: () => {
					throw new Error("boom")
				},
			}),
		)
		expect(attrs).toEqual({})
	})
})
