/**
 * One spec per section. Each gets a visually distinct shader so the six read as
 * a set without reading as copies — alternating grain gradients and dithering.
 */
const P = {
	back: "#15120e",
	amber: "#e8872b",
	amberDeep: "#8a4a18",
	amberSoft: "#f5c489",
	ember: "#b4441f",
	ink: "#2a241c",
}

const SPECS = [
	{
		file: "2026-07-alerts",
		title: "Alerts, rebuilt",
		sub: "One engine. A preview chart produced by the evaluator that actually runs the rule.",
		keys: ["preview chart", "failure reasons", "email destinations", "overview home"],
		breaking: true,
		field: {
			kind: "grain",
			shape: 1, // wave
			back: P.back,
			colors: [P.amberDeep, P.amber, P.amberSoft],
			softness: 0.78,
			intensity: 0.36,
			noise: 0.26,
			scale: 0.85,
			rotation: 12,
			offsetX: -0.5,
			opacity: 0.8,
			maskStart: 0.3,
			maskEnd: 0.78,
			frame: 1200,
		},
	},
	{
		file: "2026-07-api",
		title: "A public API",
		sub: "A documented, stability-committed v2 — and an Alchemy provider so your dashboards and rules deploy with your infrastructure.",
		keys: ["prefixed ids", "cursor pagination", "@maple-dev/alchemy", "maple auth login"],
		field: {
			kind: "dither",
			shape: 2, // warp
			type: 3, // 4x4 bayer
			back: P.back,
			front: P.amber,
			pxSize: 9,
			scale: 0.8,
			offsetX: -0.45,
			opacity: 0.85,
			maskStart: 0.4,
			maskEnd: 0.84,
			frame: 400,
		},
	},
	{
		file: "2026-07-planetscale",
		title: "PlanetScale",
		sub: "Connect with a service token and branch metrics collect themselves — no scrape target to configure by hand.",
		keys: ["branch metrics", "database inventory", "drawn behind Hyperdrive", "one-step connect"],
		field: {
			kind: "grain",
			shape: 7, // sphere
			back: P.back,
			colors: [P.amberDeep, P.amber, P.amberSoft],
			softness: 0.55,
			intensity: 0.3,
			noise: 0.28,
			scale: 0.62,
			offsetX: 0.5,
			maskStart: 0.18,
			maskEnd: 0.46,
			frame: 900,
		},
	},
	{
		file: "2026-07-billing",
		title: "Spend limits",
		sub: "Billing you can actually read — what you're spending, what's driving it, and a cap it will not cross.",
		keys: ["spend-first page", "cost by signal", "hard caps", "in-app invoices"],
		field: {
			kind: "dither",
			shape: 5, // ripple
			type: 4, // 8x8 bayer
			back: P.back,
			front: P.ember,
			pxSize: 7,
			scale: 0.42,
			offsetX: -0.44,
			opacity: 0.6,
			maskStart: 0.46,
			maskEnd: 0.9,
			frame: 700,
		},
	},
	{
		file: "2026-07-investigations",
		title: "Investigations",
		sub: "Issue to thread to evidence-backed diagnosis to approved action — one workflow that can read your source code.",
		keys: ["reads source code", "structured output", "approved actions", "escalation audit"],
		field: {
			kind: "grain",
			shape: 6, // blob
			back: P.back,
			colors: [P.ember, P.amber, P.amberSoft],
			softness: 0.6,
			intensity: 0.5,
			noise: 0.3,
			scale: 0.72,
			rotation: 200,
			offsetX: 0.46,
			maskStart: 0.2,
			maskEnd: 0.5,
			frame: 2100,
		},
	},
]

const COVER = {
	file: "changelog-2026-07",
	sub: "The biggest month yet — Maple in Slack, alerts rebuilt end to end, and a documented public API.",
	index: ["Maple in Slack", "Alerts, rebuilt", "A public API", "PlanetScale", "Spend limits", "Investigations"],
	field: {
		kind: "grain",
		shape: 7, // sphere — the same mark that opens the PlanetScale poster
		back: P.back,
		colors: [P.amberDeep, P.amber, P.amberSoft],
		softness: 0.6,
		intensity: 0.34,
		noise: 0.28,
		scale: 0.5,
		offsetX: 0.72,
		offsetY: 0.16,
		opacity: 0.85,
		maskStart: 0.42,
		maskEnd: 0.72,
		frame: 1500,
	},
}

async function renderCover() {
	await loadFonts()
	const out = document.getElementById("out")
	const canvas = await drawCover(COVER)
	canvas.style.width = "640px"
	canvas.style.height = "336px"
	out.prepend(canvas)
	return await save(COVER.file, canvas)
}

window.COVER = COVER
window.renderCover = renderCover

async function renderAll(onlyIndex) {
	await loadFonts()
	const out = document.getElementById("out")
	out.innerHTML = ""
	const list = onlyIndex == null ? SPECS : [SPECS[onlyIndex]]
	const saved = []
	for (const spec of list) {
		const lbl = document.createElement("div")
		lbl.className = "lbl"
		lbl.textContent = spec.file
		out.appendChild(lbl)
		const canvas = await drawPoster(spec)
		out.appendChild(canvas)
		saved.push(await save(spec.file, canvas))
	}
	window.__done = saved.join("\n")
	return window.__done
}

window.SPECS = SPECS
window.renderAll = renderAll
