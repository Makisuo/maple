/**
 * PairGrainient — the grainy gradient behind one cell of the /compare logo
 * pairing, in that side's brand colour.
 *
 * Wraps React Bits' `Grainient` with Maple's tokens. The three stops are the
 * brand colour, the brand colour pulled toward the page ground, and the
 * ground itself, so the swirl is one hue fading into the page rather than a
 * poster. Motion is slow and stops under `prefers-reduced-motion`.
 *
 * Mounted `client:only` — a WebGL canvas has no useful server render, and the
 * `.pair-cell` flat tint underneath is the ground until it appears.
 */
import { useState } from "react"
import Grainient from "./Grainient"

/** `--background` on the dark theme. */
const GROUND = "#1a1714"

const hexToRgb = (hex: string): [number, number, number] => {
	const n = parseInt(hex.replace("#", ""), 16)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = ([r, g, b]: [number, number, number]) =>
	`#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`

/** `color` pulled `keep` of the way from the ground (0 = ground, 1 = color). */
const towardGround = (color: string, keep: number): string => {
	const a = hexToRgb(GROUND)
	const b = hexToRgb(color)
	return toHex([a[0] + (b[0] - a[0]) * keep, a[1] + (b[1] - a[1]) * keep, a[2] + (b[2] - a[2]) * keep])
}

interface Props {
	/** Brand colour as a hex literal, e.g. "#632CA6". */
	color: string
	/** How much of the brand colour survives at the brightest stop, 0–1. */
	strength?: number
}

export function PairGrainient({ color, strength = 0.7 }: Props) {
	const [reduced] = useState(
		() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	)

	return (
		<div className="absolute inset-0" aria-hidden="true">
			<Grainient
				color1={towardGround(color, strength)}
				color2={towardGround(color, strength * 0.45)}
				color3={GROUND}
				timeSpeed={0.12}
				warpStrength={1}
				warpFrequency={3}
				warpSpeed={1.2}
				warpAmplitude={40}
				blendSoftness={0.25}
				rotationAmount={260}
				noiseScale={1.6}
				grainAmount={0.22}
				grainScale={2}
				contrast={1.15}
				saturation={1}
				zoom={0.85}
				paused={reduced}
			/>
			{/* Vignette: the mark and names sit on a calm centre. */}
			<div
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(ellipse 58% 62% at 50% 52%, color-mix(in oklab, var(--background) 45%, transparent), transparent 100%)",
				}}
			/>
		</div>
	)
}
