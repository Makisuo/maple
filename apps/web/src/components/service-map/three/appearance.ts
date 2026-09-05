import { health, HEALTH_COLOR } from "./spatial-layout"

/** WebGL material inputs in sRGB. The scene shares Maple's warm neutral surface
 * family; health is a small signal on the object, never the lighting itself. */
export const GROUND_Y = -0.36
export const MAP_MATERIALS = {
	dark: {
		air: "#d9ada5",
		ground: "#749451",
		grass: "#65924c",
		platform: "#b49468",
		turf: "#83a35d",
		body: "#b68c5c",
		cap: "#d1c4a5",
		base: "#7b7158",
		seam: "#403a2e",
		dimmed: "#686751",
	},
	light: {
		air: "#e7bba5",
		ground: "#85a660",
		grass: "#74a357",
		platform: "#c5a373",
		turf: "#92b36d",
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

/** The reference's dusk sky is scene art, independent of the app chrome theme. */
export const MAP_SKY = {
	backgroundColor: "#d9ada5",
	backgroundImage:
		"radial-gradient(ellipse at 16% 30%, #ffe5b880 0%, transparent 46%), linear-gradient(180deg, #a99bb6 0%, #d3a7b0 30%, #efbd99 65%, #f2c990 78%, #bc8eaa 100%)",
} as const
