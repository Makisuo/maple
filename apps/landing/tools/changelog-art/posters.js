/**
 * Changelog poster generator.
 *
 * Each poster is a Paper Shaders field (grain gradient or dithering) composited
 * under typography drawn straight onto a 2D canvas, so output resolution is
 * independent of the viewport — we render the backing store at SCALE× and read
 * it back with toDataURL rather than screenshotting.
 */
const { ShaderMount, grainGradientFragmentShader, ditheringFragmentShader, getShaderColorFromString, getShaderNoiseTexture } = PaperShaders

const W = 1280
const H = 660
const SCALE = 2

// Maple dark tokens (packages/ui/src/styles/tokens.css) as hex, since the
// shader uniforms want concrete colors not CSS vars.
const T = {
	bgDeep: "#15120e",
	bg: "#272219",
	fg: "#e9e2d6",
	fgMuted: "#8a7f72",
	border: "#3a342b",
	primary: "#e8872b",
	amberDeep: "#b4622a",
	amberSoft: "#f0b070",
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** getShaderNoiseTexture() hands back an <img> that ShaderMount refuses until it has decoded. */
let noiseTex = null
async function loadNoise() {
	if (noiseTex) return noiseTex
	const img = getShaderNoiseTexture()
	if (!img.complete) await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej)))
	noiseTex = img
	return img
}

async function loadFonts() {
	const display = new FontFace("GeistDisplay", "url(/fonts/geist.woff2)", { weight: "100 900" })
	const mono = new FontFace("GeistMonoGen", "url(/fonts/geist-mono.woff2)", { weight: "100 900" })
	await Promise.all([display.load(), mono.load()])
	document.fonts.add(display)
	document.fonts.add(mono)
	await document.fonts.ready
}

/** Render a shader to an offscreen-ish canvas at full scale and return it. */
async function renderField(spec) {
	// ShaderMount gates rendering on an IntersectionObserver, so the host has to
	// actually be on-screen — parking it offscreen yields an empty buffer.
	const host = document.createElement("div")
	host.style.cssText = `position:fixed;left:0;top:0;z-index:-1;opacity:0.999;width:${W}px;height:${H}px;`
	document.body.appendChild(host)

	const common = {
		u_fit: 2, // cover
		u_scale: spec.scale ?? 1,
		u_rotation: spec.rotation ?? 0,
		u_offsetX: spec.offsetX ?? 0,
		u_offsetY: spec.offsetY ?? 0,
		u_originX: 0.5,
		u_originY: 0.5,
		u_worldWidth: 0,
		u_worldHeight: 0,
	}

	let uniforms
	let frag
	if (spec.kind === "dither") {
		frag = ditheringFragmentShader
		uniforms = {
			...common,
			u_colorBack: getShaderColorFromString(spec.back),
			u_colorFront: getShaderColorFromString(spec.front),
			u_shape: spec.shape,
			u_type: spec.type,
			u_pxSize: spec.pxSize,
		}
	} else {
		frag = grainGradientFragmentShader
		const colors = spec.colors.map(getShaderColorFromString)
		uniforms = {
			...common,
			u_colorBack: getShaderColorFromString(spec.back),
			u_colors: colors,
			u_colorsCount: colors.length,
			u_softness: spec.softness,
			u_intensity: spec.intensity,
			u_noise: spec.noise,
			u_shape: spec.shape,
			u_noiseTexture: await loadNoise(),
		}
	}

	const mount = new ShaderMount(
		host,
		frag,
		uniforms,
		{ preserveDrawingBuffer: true },
		0, // speed 0 → static, deterministic
		spec.frame ?? 0,
		SCALE, // minPixelRatio → backing store is W*SCALE × H*SCALE
		W * SCALE * H * SCALE * 4,
	)

	// setFrame() calls render() synchronously and render() never consults
	// visibility — so this draws even when the browser pane is hidden and rAF
	// is suspended. Do NOT await requestAnimationFrame here; it will never fire.
	mount.setFrame(spec.frame ?? 0)

	const canvas = host.querySelector("canvas")
	// Copy pixels out before disposing the GL context.
	const out = document.createElement("canvas")
	out.width = W * SCALE
	out.height = H * SCALE
	const ctx = out.getContext("2d")
	ctx.drawImage(canvas, 0, 0, out.width, out.height)
	mount.dispose()
	host.remove()
	return out
}

/* ── Typography, drawn at SCALE ───────────────────────────────────────────── */

const px = (n) => n * SCALE
const mono = (size, weight = 400) => `${weight} ${px(size)}px GeistMonoGen`
const display = (size, weight = 600) => `${weight} ${px(size)}px GeistDisplay`

function tracked(ctx, text, x, y, tracking) {
	// Canvas has no letter-spacing in older engines; emulate per-glyph.
	if ("letterSpacing" in ctx) {
		ctx.letterSpacing = `${px(tracking)}px`
		ctx.fillText(text, x, y)
		ctx.letterSpacing = "0px"
		return ctx.measureText(text).width
	}
	let cx = x
	for (const ch of text) {
		ctx.fillText(ch, cx, y)
		cx += ctx.measureText(ch).width + px(tracking)
	}
	return cx - x
}

function wrap(ctx, text, maxWidth) {
	const words = text.split(" ")
	const lines = []
	let line = ""
	for (const w of words) {
		const test = line ? `${line} ${w}` : w
		if (ctx.measureText(test).width > maxWidth && line) {
			lines.push(line)
			line = w
		} else line = test
	}
	if (line) lines.push(line)
	return lines
}

function drawMark(ctx, x, y, size) {
	const r = px(size) * 0.26
	const s = px(size)
	ctx.fillStyle = T.primary
	ctx.beginPath()
	ctx.roundRect(x, y, s, s, r)
	ctx.fill()
	ctx.fillStyle = T.bg
	ctx.font = display(size * 0.62, 600)
	ctx.textBaseline = "middle"
	ctx.textAlign = "center"
	ctx.fillText("M", x + s / 2, y + s * 0.54)
	ctx.textAlign = "left"
	ctx.textBaseline = "alphabetic"
}

/**
 * Fade the field out across the left half so the headline always sits on clean
 * ground. Doing this at composite time means every shader gets the same
 * guarantee — no per-shader offset tuning, and legibility can't regress when a
 * spec changes.
 */
function maskField(field, spec) {
	const m = document.createElement("canvas")
	m.width = field.width
	m.height = field.height
	const mx = m.getContext("2d")
	mx.drawImage(field, 0, 0)

	mx.globalCompositeOperation = "destination-in"
	const g = mx.createLinearGradient(0, 0, m.width, 0)
	const start = spec.maskStart ?? 0.26
	const end = spec.maskEnd ?? 0.72
	g.addColorStop(0, "rgba(0,0,0,0)")
	g.addColorStop(start, "rgba(0,0,0,0)")
	g.addColorStop((start + end) / 2, "rgba(0,0,0,0.42)")
	g.addColorStop(end, "rgba(0,0,0,1)")
	g.addColorStop(1, "rgba(0,0,0,1)")
	mx.fillStyle = g
	mx.fillRect(0, 0, m.width, m.height)
	return m
}

async function drawPoster(spec) {
	const field = await renderField(spec.field)
	const c = document.createElement("canvas")
	c.width = W * SCALE
	c.height = H * SCALE
	const ctx = c.getContext("2d")

	ctx.fillStyle = T.bgDeep
	ctx.fillRect(0, 0, c.width, c.height)

	ctx.globalAlpha = spec.field.opacity ?? 0.92
	ctx.drawImage(maskField(field, spec.field), 0, 0)
	ctx.globalAlpha = 1

	const PAD = px(64)

	// ── Top rail: mark + JULY 2026, optional BREAKING key on the right
	drawMark(ctx, PAD, px(52), 20)
	ctx.fillStyle = T.fgMuted
	ctx.font = mono(11, 500)
	tracked(ctx, "JULY 2026", PAD + px(32), px(52) + px(14.5), 1.7)

	if (spec.breaking) {
		const label = "BREAKING"
		ctx.font = mono(9, 500)
		const w = ctx.measureText(label).width + px(9) * 1.6 + px(14)
		const bx = c.width - PAD - w
		const by = px(52) - px(2)
		ctx.strokeStyle = T.primary
		ctx.lineWidth = px(1)
		ctx.beginPath()
		ctx.roundRect(bx, by, w, px(22), px(3))
		ctx.stroke()
		ctx.fillStyle = T.primary
		tracked(ctx, label, bx + px(7), by + px(15), 1.6)
	}

	// ── Headline, optically centered
	ctx.fillStyle = T.fg
	ctx.font = display(spec.size ?? 104, 600)
	const headY = c.height * 0.5 - px(8)
	ctx.fillText(spec.title, PAD, headY)

	// ── Subtext
	ctx.fillStyle = T.fgMuted
	ctx.font = mono(17, 400)
	const lines = wrap(ctx, spec.sub, px(620))
	lines.forEach((l, i) => ctx.fillText(l, PAD, headY + px(52) + i * px(28)))

	// ── Foot rail
	ctx.font = mono(13, 400)
	let fx = PAD
	spec.keys.forEach((k, i) => {
		if (i) {
			ctx.fillStyle = T.border
			ctx.fillText("/", fx, c.height - px(52))
			fx += ctx.measureText("/").width + px(26)
		}
		ctx.fillStyle = T.fgMuted
		ctx.fillText(k, fx, c.height - px(52))
		fx += ctx.measureText(k).width + px(26)
	})

	return c
}

/** The release cover / OG card. Same field language, ledger layout. */
async function drawCover(spec) {
	const CW = 1200
	const CH = 630
	const field = await renderField({ ...spec.field, w: CW, h: CH })
	const c = document.createElement("canvas")
	c.width = CW * SCALE
	c.height = CH * SCALE
	const ctx = c.getContext("2d")

	ctx.fillStyle = T.bgDeep
	ctx.fillRect(0, 0, c.width, c.height)
	ctx.globalAlpha = spec.field.opacity ?? 0.9
	// The field is rendered at poster size; cover-fit it onto the card.
	const s = Math.max(c.width / field.width, c.height / field.height)
	const masked = maskField(field, spec.field)
	ctx.drawImage(masked, (c.width - field.width * s) / 2, (c.height - field.height * s) / 2, field.width * s, field.height * s)
	ctx.globalAlpha = 1

	const PAD = px(40)

	// Top rail
	drawMark(ctx, PAD, px(20), 22)
	ctx.fillStyle = T.fgMuted
	ctx.font = mono(11, 500)
	tracked(ctx, "MAPLE  /  CHANGELOG", PAD + px(34), px(20) + px(15.5), 1.7)
	ctx.textAlign = "right"
	tracked(ctx, "MAPLE.DEV/CHANGELOG", c.width - PAD, px(20) + px(15.5), 1.7)
	ctx.textAlign = "left"
	ctx.fillStyle = T.border
	ctx.fillRect(0, px(62), c.width, px(1))

	// Left: the month, set big
	ctx.fillStyle = T.fgMuted
	ctx.font = mono(11, 500)
	tracked(ctx, "RELEASE 2026-07", PAD, px(160), 1.7)
	ctx.fillStyle = T.fg
	ctx.font = display(124, 600)
	ctx.fillText("July", PAD - px(4), px(285))
	ctx.fillStyle = T.fgMuted
	ctx.font = display(124, 300)
	ctx.fillText("2026", PAD - px(4), px(400))

	ctx.font = mono(14, 400)
	const lines = wrap(ctx, spec.sub, px(470))
	lines.forEach((l, i) => ctx.fillText(l, PAD, px(462) + i * px(24)))

	// Right: the release index
	const RX = px(700)
	ctx.fillStyle = T.border
	ctx.fillRect(RX - px(40), px(63), px(1), c.height - px(63) - px(56))

	ctx.fillStyle = T.fgMuted
	ctx.font = mono(11, 500)
	tracked(ctx, "IN THIS RELEASE", RX, px(184), 1.7)

	// BREAKING key
	ctx.font = mono(9, 500)
	const bw = ctx.measureText("BREAKING").width + px(9) * 1.6 + px(14)
	const bx = c.width - PAD - bw
	ctx.strokeStyle = T.primary
	ctx.lineWidth = px(1)
	ctx.beginPath()
	ctx.roundRect(bx, px(170), bw, px(20), px(2))
	ctx.stroke()
	ctx.fillStyle = T.primary
	tracked(ctx, "BREAKING", bx + px(7), px(184), 1.6)

	spec.index.forEach((label, i) => {
		const y = px(212) + i * px(45)
		ctx.fillStyle = T.border
		ctx.fillRect(RX, y, c.width - PAD - RX, px(1))
		ctx.fillStyle = T.fgMuted
		ctx.font = mono(11, 400)
		ctx.fillText(String(i + 1).padStart(2, "0"), RX, y + px(28))
		ctx.fillStyle = T.fg
		ctx.font = mono(15, 500)
		ctx.fillText(label, RX + px(38), y + px(28))
	})
	ctx.fillStyle = T.border
	ctx.fillRect(RX, px(212) + spec.index.length * px(45), c.width - PAD - RX, px(1))

	// Bottom rail
	ctx.fillStyle = T.border
	ctx.fillRect(0, c.height - px(56), c.width, px(1))
	ctx.fillStyle = T.fgMuted
	ctx.font = mono(11, 400)
	tracked(ctx, "31 JULY 2026", PAD, c.height - px(22), 1.7)
	ctx.textAlign = "right"
	tracked(ctx, "OBSERVABILITY FOR PEOPLE WHO SHIP", c.width - PAD, c.height - px(22), 1.7)
	ctx.textAlign = "left"

	return c
}

async function save(name, canvas) {
	const dataUrl = canvas.toDataURL("image/png")
	const res = await fetch("/save", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, dataUrl }),
	})
	return res.text()
}

window.T = T
window.drawPoster = drawPoster
window.drawCover = drawCover
window.renderField = renderField
window.save = save
window.loadFonts = loadFonts
window.POSTER_W = W
window.POSTER_H = H
