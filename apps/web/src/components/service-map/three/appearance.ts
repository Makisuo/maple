import { health, HEALTH_COLOR } from "./spatial-layout"

/** WebGL material inputs in sRGB. The scene shares Maple's warm neutral surface
 * family; health is a small signal on the object, never the lighting itself. */
export const GROUND_Y = -0.36
export const MAP_MATERIALS = {
	dark: {
		air: "#242c2a",
		ground: "#669747",
		grass: "#8bbd52",
		platform: "#5a4b37",
		turf: "#71a84a",
		body: "#b68c5c",
		cap: "#d1c4a5",
		base: "#7b7158",
		seam: "#403a2e",
		dimmed: "#686751",
	},
	light: {
		air: "#e8efeb",
		ground: "#72a14f",
		grass: "#9ac664",
		platform: "#948160",
		turf: "#82b258",
		body: "#c39965",
		cap: "#e3d7b8",
		base: "#a89978",
		seam: "#514939",
		dimmed: "#a3a186",
	},
} as const

export const FACTORY_FINISH = {
	amber: "#e86f00",
	steel: "#a3a18a",
	pipe: "#82927a",
	collar: "#c6b897",
	paint: {
		processor: "#cb8a3a",
		tank: "#779572",
		loader: "#dea13f",
		gateway: "#d98b33",
		pump: "#a2967f",
	},
} as const

export function connectionStyle(errorRate: number, dark: boolean, active: boolean, dimmed: boolean) {
	let color = dark ? "#6c8073" : "#42614e"
	if (active) color = dark ? "#b9d6c6" : "#42614e"
	if (errorRate >= 0.01)
		color = dark ? HEALTH_COLOR[health(errorRate)] : errorRate >= 0.02 ? "#a95a4a" : "#9d762b"
	return { color, opacity: dimmed ? 0.08 : active ? 0.95 : dark ? 0.48 : 0.72 }
}
