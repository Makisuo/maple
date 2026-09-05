import { describe, expect, it } from "vitest"
import { getActiveInfraCorrelations } from "./infra-correlations"

describe("getActiveInfraCorrelations", () => {
	it("returns no groups for empty/missing resource attributes", () => {
		expect(getActiveInfraCorrelations(null)).toEqual([])
		expect(getActiveInfraCorrelations(undefined)).toEqual([])
		expect(getActiveInfraCorrelations({})).toEqual([])
		expect(getActiveInfraCorrelations({ "service.name": "checkout" })).toEqual([])
	})

	it("treats empty-string identity values as absent", () => {
		// Warehouse resource maps default missing keys to "" — must not surface a
		// group that would query/link to an empty identifier.
		expect(
			getActiveInfraCorrelations({
				"k8s.pod.name": "",
				"k8s.node.name": "",
				"host.name": "",
			}),
		).toEqual([])
	})

	it("detects a pod and builds a namespaced deep-link", () => {
		const [pod] = getActiveInfraCorrelations({
			"k8s.pod.name": "checkout-7c9f",
			"k8s.namespace.name": "prod",
		})
		expect(pod.kind).toBe("pod")
		expect(pod.identifier).toBe("checkout-7c9f")
		expect(pod).toMatchObject({ namespace: "prod" })
	})

	it("leaves namespace undefined when none is present", () => {
		const [pod] = getActiveInfraCorrelations({ "k8s.pod.name": "checkout-7c9f" })
		expect(pod.kind).toBe("pod")
		expect(pod).toMatchObject({ namespace: undefined })
	})

	it("detects a node", () => {
		const groups = getActiveInfraCorrelations({ "k8s.node.name": "ip-10-0-1-5" })
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			kind: "node",
			identifier: "ip-10-0-1-5",
		})
	})

	it("detects a host", () => {
		const groups = getActiveInfraCorrelations({ "host.name": "ip-10-0-1-5.ec2.internal" })
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			kind: "host",
			identifier: "ip-10-0-1-5.ec2.internal",
		})
	})

	it("emits both Pod and Node groups in order for a k8s span", () => {
		const groups = getActiveInfraCorrelations({
			"k8s.pod.name": "checkout-7c9f",
			"k8s.namespace.name": "prod",
			"k8s.node.name": "ip-10-0-1-5",
		})
		expect(groups.map((g) => g.kind)).toEqual(["pod", "node"])
	})

	it("passes identifiers and namespaces through raw (Link owns URL encoding)", () => {
		// The deep-link is built by CorrelationLink via TanStack <Link>, which
		// encodes params itself — the detector must not pre-encode.
		const [pod] = getActiveInfraCorrelations({
			"k8s.pod.name": "weird/pod name",
			"k8s.namespace.name": "team a/b",
		})
		expect(pod.identifier).toBe("weird/pod name")
		expect(pod).toMatchObject({ namespace: "team a/b" })
	})

	it("detects a Docker container and carries the host for the deep-link", () => {
		const groups = getActiveInfraCorrelations({
			"container.name": "redis",
			"host.name": "docker-host-1",
		})
		expect(groups.map((g) => g.kind)).toEqual(["container", "host"])
		expect(groups[0]).toMatchObject({
			kind: "container",
			identifier: "redis",
			hostName: "docker-host-1",
		})
	})

	it("suppresses the container group on k8s records — kubeletstats rows also carry container.name", () => {
		const groups = getActiveInfraCorrelations({
			"container.name": "app",
			"k8s.pod.name": "checkout-7c9f",
			"k8s.node.name": "ip-10-0-1-5",
		})
		expect(groups.map((g) => g.kind)).toEqual(["pod", "node"])
	})

	it("treats an empty container.name as absent", () => {
		expect(getActiveInfraCorrelations({ "container.name": "" })).toEqual([])
	})

	it("suppresses the container group when a non-docker runtime is declared", () => {
		// containerd/cri-o records have no docker_stats metrics — the group would
		// be a stack of empty charts.
		const groups = getActiveInfraCorrelations({
			"container.name": "app",
			"container.runtime": "containerd",
			"host.name": "node-1",
		})
		expect(groups.map((g) => g.kind)).toEqual(["host"])
	})

	it("keeps the container group when container.runtime is docker", () => {
		const groups = getActiveInfraCorrelations({
			"container.name": "app",
			"container.runtime": "docker",
		})
		expect(groups.map((g) => g.kind)).toEqual(["container"])
	})

	/**
	 * Semconv v1.37.0 renamed the key. Reading only the old spelling made a
	 * canonical runtime read as absent, and absent *passes* the docker check —
	 * so a containerd record would have rendered the empty docker chart stack
	 * the check above exists to prevent. Both spellings, both directions.
	 */
	it("honours the renamed container.runtime.name in both directions", () => {
		expect(
			getActiveInfraCorrelations({
				"container.name": "app",
				"container.runtime.name": "containerd",
				"host.name": "node-1",
			}).map((g) => g.kind),
		).toEqual(["host"])

		expect(
			getActiveInfraCorrelations({
				"container.name": "app",
				"container.runtime.name": "docker",
			}).map((g) => g.kind),
		).toEqual(["container"])
	})

	it("prefers the canonical spelling when an instrumentation sends both", () => {
		// Dual-emitting SDKs exist; the canonical key is the one to believe.
		const groups = getActiveInfraCorrelations({
			"container.name": "app",
			"container.runtime.name": "containerd",
			"container.runtime": "docker",
			"host.name": "node-1",
		})
		expect(groups.map((g) => g.kind)).toEqual(["host"])
	})

	it("each group carries at least one chart", () => {
		const groups = getActiveInfraCorrelations({
			"k8s.pod.name": "p",
			"k8s.node.name": "n",
			"host.name": "h",
		})
		expect(groups.map((g) => g.kind)).toEqual(["pod", "node", "host"])
		for (const g of groups) {
			expect(g.charts.length).toBeGreaterThan(0)
		}
	})
})
