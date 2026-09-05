import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY as topology } from "@/lab/service-map-3d/fixture"
import { factoryLinks, factoryRoutes, decorateRoutes, beltGeometry, CurveSection } from "./factory-routing"
import { spatialLayout } from "./spatial-layout"

describe("factory transports", () => {
	it("updates live rates without replacing transport geometry", () => {
		const routes = factoryRoutes(topology, spatialLayout(topology, "atlas"))
		const before = decorateRoutes(routes, topology.edges)
		const updatedEdges = topology.edges.map((edge) => ({
			...edge,
			callsPerSecond: edge.callsPerSecond + 100,
		}))
		const after = decorateRoutes(routes, updatedEdges)
		for (const [index, link] of after.entries()) {
			expect(link.curve).toBe(before[index]?.curve)
			expect(link.geometryKey).toBe(before[index]?.geometryKey)
			expect(link.edge.callsPerSecond).toBe((before[index]?.edge.callsPerSecond ?? 0) + 100)
		}
	})
	it.each(["atlas", "cascade"] as const)(
		"routes every call with finite, continuous geometry in %s",
		(view) => {
			const links = factoryLinks(topology, spatialLayout(topology, view))
			expect(links).toHaveLength(topology.edges.length)
			for (const link of links) {
				expect(link.curve.getLength()).toBeGreaterThan(0)
				let previous = link.curve.getPointAt(0)
				for (let i = 1; i <= 100; i++) {
					const point = link.curve.getPointAt(i / 100)
					expect(point.toArray().every(Number.isFinite)).toBe(true)
					expect(
						link.curve
							.getTangentAt(i / 100)
							.toArray()
							.every(Number.isFinite),
					).toBe(true)
					expect(point.distanceTo(previous)).toBeLessThan(link.curve.getLength() / 50)
					previous = point
				}
				const glass = new CurveSection(link.curve, 0.38, 0.62)
				expect(glass.getPoint(0).distanceTo(link.curve.getPointAt(0.38))).toBeLessThan(0.0001)
				expect(glass.getPoint(1).distanceTo(link.curve.getPointAt(0.62))).toBeLessThan(0.0001)
			}
		},
	)
	it("uses conveyors only for calls involving a queue", () => {
		const nodes = new Map(topology.nodes.map((node) => [node.id, node]))
		for (const link of factoryLinks(topology, spatialLayout(topology, "atlas"))) {
			const queued =
				nodes.get(link.edge.source)?.kind === "queue" || nodes.get(link.edge.target)?.kind === "queue"
			expect(link.kind).toBe(queued ? "conveyor" : "pipe")
			expect(link.signPosition.y).toBeGreaterThan(link.curve.getPointAt(0.5).y)
		}
	})
	it("builds finite indexed belt decks on slopes and elbows", () => {
		for (const link of factoryLinks(topology, spatialLayout(topology, "cascade")).filter(
			(link) => link.kind === "conveyor",
		)) {
			const geometry = beltGeometry(link.curve, 0.8)
			expect([...geometry.getAttribute("position").array].every(Number.isFinite)).toBe(true)
			expect([...geometry.getAttribute("normal").array].every(Number.isFinite)).toBe(true)
			expect(geometry.getIndex()?.count).toBe(480)
			geometry.dispose()
		}
	})
})
