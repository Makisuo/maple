// @vitest-environment jsdom
import { type ComponentProps } from "react"
import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { Position } from "@xyflow/react"
import { ServiceMapEdge } from "./service-map-edge"
import type { ServiceEdgeData } from "./service-map-utils"

function renderEdge(overrides: Partial<ServiceEdgeData> = {}) {
	const data: ServiceEdgeData = {
		callCount: 5000,
		callsPerSecond: 80,
		estimatedCallsPerSecond: 80,
		errorCount: 0,
		errorRate: 0,
		avgDurationMs: 5,
		p95DurationMs: 10,
		hasSampling: false,
		services: ["api", "auth"],
		...overrides,
	}
	const props = {
		id: "edge:api:auth",
		source: "api",
		target: "auth",
		sourceX: 0,
		sourceY: 0,
		targetX: 160,
		targetY: 80,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		data,
	} as ComponentProps<typeof ServiceMapEdge>

	return render(
		<svg>
			<ServiceMapEdge {...props} />
		</svg>,
	)
}

describe("ServiceMapEdge", () => {
	it("renders no SVG blur filters or SMIL animations (CPU regression guard)", () => {
		const { container } = renderEdge({ callsPerSecond: 500 })

		// The expensive constructs that previously re-rasterized every frame.
		expect(container.querySelectorAll("feGaussianBlur")).toHaveLength(0)
		expect(container.querySelectorAll("filter")).toHaveLength(0)
		expect(container.querySelectorAll("animateMotion")).toHaveLength(0)
		expect(container.querySelectorAll("animate")).toHaveLength(0)
		expect(container.querySelector(".service-map-flowing-dash")).toBeNull()
	})

	it("still renders the gradient tube + label", () => {
		const { container } = renderEdge()
		expect(container.querySelector("linearGradient")).not.toBeNull()
		expect(container.querySelectorAll("path").length).toBeGreaterThan(0)
		expect(container.querySelector("foreignObject")).not.toBeNull()
	})
})
